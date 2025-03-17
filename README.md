## Getting started

Install with npm

```
npm i
```

## Sending Dogecoin

1. Save `.env.example` as `.env` and fill in all required env vars

2. Run the send script using `ts-node src/send-doge.tx <recipient> <amount> [options]`

   ```
   npx ts-node src/send-doge.ts nVM2Zzh9mKS6tWKTz5N28tS8xkNeQJMMB9 0.42 -t
   ```

   - Remove `-t` for mainnet
   - Use `-s` flag to send the transaction
