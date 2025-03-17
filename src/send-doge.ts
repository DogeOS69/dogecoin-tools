#!/usr/bin/env ts-node

import * as dotenv from 'dotenv';
import { program } from 'commander';
import axios from 'axios';
import * as bitcore from 'bitcore-lib-doge';

// Configure dotenv to load environment variables
dotenv.config();

// Constants
const SATOSHIS_PER_DOGE = 1e8;
const DUST_THRESHOLD = 100000; // Minimum satoshis for an output
const BASE_TX_SIZE = 10; // Base transaction size in bytes
const INPUT_SIZE = 148; // Approx size per input in bytes
const OUTPUT_SIZE = 34; // Approx size per output in bytes

// Override bitcore-lib-doge's default dust amount
bitcore.Transaction.DUST_AMOUNT = DUST_THRESHOLD;

// Load environment variables
const SENDER_ADDRESS = process.env.SENDER_ADDRESS;
const PRIVATE_KEY_WIF = process.env.PRIVATE_KEY_WIF;
const RPC_URL = process.env.RPC_URL;
const RPC_USER = process.env.RPC_USER;
const RPC_PASSWORD = process.env.RPC_PASSWORD;
const NOWNODES_API_KEY = process.env.NOWNODES_API_KEY;

export const nownodes = axios.create({
  headers: {
    'api-key': NOWNODES_API_KEY,
  },
});

if (
  !SENDER_ADDRESS ||
  !PRIVATE_KEY_WIF ||
  !RPC_URL ||
  !RPC_USER ||
  !RPC_PASSWORD ||
  !NOWNODES_API_KEY
) {
  console.error('Error: Missing required environment variables in .env');
  process.exit(1);
}
console.log('Loaded environment variables successfully');

// Parse CLI arguments
program
  .argument('<recipient>', 'Recipient Dogecoin address')
  .argument('<amount>', 'Amount to send in Dogecoin', parseFloat)
  .option('-o, --op-return <string>', 'Optional OP_RETURN string')
  .option('-f, --fee <fee>', 'Fee in DOGE/kb (default: 0.01)', parseFloat, 0.01)
  .option('-t, --testnet', 'Use Dogecoin testnet (default: false)', false)
  .option('-s, --send', 'Send the transaction (default: false)', false)
  .action(async (recipient: string, amount: number, options: any) => {
    console.log('CLI Arguments:', { recipient, amount, ...options });

    // Set network
    const isTestnet = options.testnet;
    const network = isTestnet
      ? bitcore.Networks.testnet
      : bitcore.Networks.livenet;
    console.log(
      `Using network: ${isTestnet ? 'dogecoin-testnet' : 'dogecoin-mainnet'}`
    );

    // Convert amounts to satoshis
    const amountSat = Math.floor(amount * SATOSHIS_PER_DOGE);
    const feeSatPerKb = Math.floor(options.fee * SATOSHIS_PER_DOGE);
    const feeRate = feeSatPerKb / 1000; // Satoshis per byte
    console.log(`Amount: ${amount} DOGE (${amountSat} satoshis)`);
    console.log(
      `Fee rate: ${options.fee} DOGE/kb (${feeSatPerKb} satoshis/kb)`
    );

    // Initialize private key
    const privateKey = new bitcore.PrivateKey(PRIVATE_KEY_WIF, network);
    console.log('Private key initialized');

    // Fetch UTXOs
    const apiBase = isTestnet
      ? 'https://dogebook-testnet.nownodes.io'
      : 'https://dogebook.nownodes.io';
    console.log(`Fetching UTXOs from ${apiBase}`);
    const utxoResponse = await nownodes.get(
      `${apiBase}/api/v2/utxo/${SENDER_ADDRESS}`
    );
    const rawUtxos: { txid: string; vout: number; value: number }[] =
      utxoResponse.data;

    // Map UTXOs to bitcore format
    const utxos = rawUtxos.map((utxo) => ({
      txid: utxo.txid,
      vout: utxo.vout,
      satoshis: Number(utxo.value),
    }));
    console.log(`Fetched ${utxos.length} UTXOs`);

    // Sort UTXOs by amount descending for greedy selection
    utxos.sort((a, b) => b.satoshis - a.satoshis);

    // Select UTXOs with logging
    const inputs: typeof utxos = [];
    let totalInput = 0;
    const numberOfOutputs = options.opReturn ? 3 : 2; // Recipient + Change, + OP_RETURN if present
    const availableUtxos = utxos.slice();

    const calculateEstimatedFee = (nInputs: number) =>
      (BASE_TX_SIZE + INPUT_SIZE * nInputs + OUTPUT_SIZE * numberOfOutputs) *
      feeRate;

    console.log('Selecting UTXOs:');
    while (
      availableUtxos.length > 0 &&
      totalInput < amountSat + calculateEstimatedFee(inputs.length + 1)
    ) {
      const utxo = availableUtxos.shift()!;
      inputs.push(utxo);
      totalInput += utxo.satoshis;
      console.log(
        `Added UTXO: txid=${utxo.txid}, vout=${utxo.vout}, amount=${
          utxo.satoshis
        } satoshis (${
          utxo.satoshis / SATOSHIS_PER_DOGE
        } DOGE), Total input now: ${totalInput} satoshis (${
          totalInput / SATOSHIS_PER_DOGE
        } DOGE)`
      );
    }

    if (totalInput < amountSat + calculateEstimatedFee(inputs.length)) {
      console.error('Error: Insufficient funds even with all UTXOs');
      process.exit(1);
    }
    console.log(
      `Selected ${inputs.length} UTXOs with total ${totalInput} satoshis (${
        totalInput / SATOSHIS_PER_DOGE
      } DOGE)`
    );

    // Build transaction with selected UTXOs
    const tx = new bitcore.Transaction()
      .from(
        inputs.map((utxo) => ({
          txId: utxo.txid,
          outputIndex: utxo.vout,
          satoshis: utxo.satoshis,
          script: bitcore.Script.fromAddress(SENDER_ADDRESS).toHex(),
        }))
      )
      .to(recipient, amountSat)
      .feePerKb(feeSatPerKb); // Set fee rate using built-in method

    // Add OP_RETURN if provided
    if (options.opReturn) {
      if (Buffer.from(options.opReturn, 'hex').length > 80) {
        console.error('Error: OP_RETURN data exceeds 80 bytes');
        process.exit(1);
      }
      tx.addData(Buffer.from(options.opReturn, 'hex'));
      console.log(`Added OP_RETURN: ${options.opReturn}`);
    }

    // Always set change address to handle remaining funds
    tx.change(SENDER_ADDRESS);
    console.log('Change address set to:', SENDER_ADDRESS);

    // Sign the transaction
    tx.sign(privateKey);
    console.log('Transaction built and signed');

    // Serialize and calculate final details
    const serializedTx = tx.serialize();
    const txSize = Buffer.from(serializedTx, 'hex').length;
    const exactFee = tx.getFee();
    const changeSat = tx.getChangeOutput()?.satoshis || 0;

    console.log(`Transaction size: ${txSize} bytes`);
    console.log(
      `Total output: ${amountSat + changeSat} satoshis (${
        (amountSat + changeSat) / SATOSHIS_PER_DOGE
      } DOGE)`
    );
    console.log(
      `Exact fee: ${exactFee} satoshis (${exactFee / SATOSHIS_PER_DOGE} DOGE)`
    );
    console.log(
      `Change: ${changeSat} satoshis (${changeSat / SATOSHIS_PER_DOGE} DOGE)`
    );

    // Verify sufficient funds
    if (totalInput < amountSat + exactFee) {
      console.error('Error: Insufficient funds');
      process.exit(1);
    }

    // Additional validation: Check if change is negative or total doesn't balance
    const totalOutput = amountSat + changeSat + exactFee;
    console.log(
      `Transaction balance check: Total input (${totalInput}) vs Total output + fee (${totalOutput})`
    );
    if (totalInput !== totalOutput) {
      console.error('Error: Transaction does not balance');
      process.exit(1);
    }

    // Send transaction if enabled
    if (options.send) {
      console.log('Sending transaction to RPC');
      const rpcResponse = await axios.post(
        RPC_URL,
        {
          jsonrpc: '1.0',
          id: '1',
          method: 'sendrawtransaction',
          params: [serializedTx],
        },
        {
          auth: { username: RPC_USER, password: RPC_PASSWORD },
          headers: { 'Content-Type': 'application/json' },
        }
      );
      console.log(`Transaction sent. TxID: ${rpcResponse.data.result}`);
    } else {
      console.log(
        'Send flag is false. Serialized transaction (for debugging):',
        serializedTx
      );
    }
  });

program.parse(process.argv);
