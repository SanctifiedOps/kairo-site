# KAIRO Security Guidelines

## Critical Security Considerations

### 1. Private Key Management

**DEPLOYER_WALLET_KEY** contains the private key that controls all creator fee withdrawals and SOL distributions. Compromise of this key means loss of all funds.

#### Current State: INSECURE
- Private key stored in environment variable
- If `.env` file is committed or server is compromised, funds are lost
- No rotation mechanism

#### Required Improvements:

**Option A: AWS KMS (Recommended for AWS deployments)**
```bash
# Store key in KMS
aws kms create-key --description "KAIRO deployer wallet"

# Update code to use KMS for signing
# See: https://docs.aws.amazon.com/kms/latest/developerguide/programming-keys.html
```

**Option B: Google Cloud Secret Manager (Recommended for GCP/Firebase)**
```bash
# Store key in Secret Manager
gcloud secrets create deployer-wallet-key --data-file=key.json

# Update code to fetch from Secret Manager
# See: https://cloud.google.com/secret-manager/docs
```

**Option C: Hardware Wallet / Ledger**
- Use Ledger hardware wallet for signing transactions
- Never expose private key to server
- See: https://github.com/solana-labs/wallet-adapter

#### Immediate Actions Required:
1. ✅ **NEVER** commit `.env` file to git
2. ✅ Add `.env` to `.gitignore`
3. ✅ Rotate deployer key if you suspect it was ever committed
4. ⚠️ Implement KMS or Secret Manager before mainnet deployment
5. ⚠️ Set up key rotation schedule (every 90 days minimum)

### 2. Admin Key Security

The `ADMIN_KEY` environment variable controls admin endpoints like `/api/admin/cycle`.

**Current Implementation:** Basic bearer token in env var

**Recommendations:**
- Use a strong random key (minimum 32 characters)
- Generate with: `openssl rand -base64 32`
- Store in secure vault (KMS/Secret Manager)
- Implement key rotation
- Add IP allowlisting for admin endpoints
- Consider using JWT tokens with expiration

### 3. Firebase Service Account

The `FIREBASE_SERVICE_ACCOUNT` contains full admin access to your Firestore database.

**Security Checklist:**
- ✅ Never commit service account JSON to git
- ✅ Store in Secret Manager or KMS
- ⚠️ Use least-privilege IAM roles
- ⚠️ Enable Firestore security rules
- ⚠️ Rotate service account keys quarterly

### 4. API Keys

**OpenAI API Key (`OPENAI_API_KEY`):**
- Compromised key = unlimited AI usage charges
- Set usage limits in OpenAI dashboard
- Monitor usage daily

**Anthropic API Key (`ANTHROPIC_API_KEY`):**
- Same risks as OpenAI
- Set budget alerts
- Monitor for unusual activity

**Solana RPC URL (`HELIUS_RPC_URL`):**
- If using Helius with API key embedded, treat as secret
- Use environment variable, never hardcode

### 5. Rate Limiting Bypass Prevention

Current implementation uses wallet-based rate limiting (6 requests per minute).

**Known Bypass Vectors:**
- Attacker can create unlimited wallet addresses
- No CAPTCHA on voting endpoint

**Mitigations Needed:**
- ✅ Wallet signature verification (implemented)
- ⚠️ Add CAPTCHA for suspicious activity
- ⚠️ Implement progressive rate limiting (stricter limits for new wallets)
- ⚠️ Monitor for distributed voting attacks

### 6. Solana Signature Verification

**CRITICAL:** Wallet signature verification is now implemented and REQUIRED for all votes.

**How it works:**
1. Frontend creates message: `KAIRO VOTE\ncycleId: {...}\nstance: {...}\nexpires: {...}`
2. User signs message with Solana wallet
3. Backend verifies signature matches wallet address
4. Backend checks message matches current cycle

**What to verify:**
- Message format is exact (including newlines)
- Signature is base58-encoded
- Timestamp hasn't expired
- Wallet address is valid Solana public key

### 7. Environment Variable Security

**Required env vars for production:**
```bash
# AI Providers (at least one required)
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-...

# Database
FIREBASE_SERVICE_ACCOUNT={"type":"service_account",...}
FIREBASE_PROJECT_ID=kairo-prod

# Solana
SOLANA_RPC_URL=https://...
DEPLOYER_WALLET_KEY=[...]  # SECURE THIS!
TOKEN_MINT_ADDRESS=...      # After token launch

# Security
ADMIN_KEY=...               # Strong random string

# Feature flags
ENABLE_TOKEN_GATING=false   # Set true after token launch
```

**Storage recommendations:**
- **Development:** `.env` file (gitignored)
- **Staging:** Netlify env vars or Secret Manager
- **Production:** Secret Manager / KMS ONLY

### 8. Token Gating Security

Once `ENABLE_TOKEN_GATING=true`:
- Users must hold `TOKEN_MIN_BALANCE` tokens to vote
- System queries Solana RPC for token balance
- Ensure RPC is reliable (use Helius/QuickNode, not public RPC)
- Cache token balances briefly to prevent RPC spam

### 9. Firestore Security Rules

**CRITICAL:** Current code assumes no security rules. Before production, add:

```javascript
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    // Public read for latest state
    match /state/latest {
      allow read: if true;
      allow write: if false;  // Only backend writes
    }

    // No public access to cycles
    match /cycles/{cycleId} {
      allow read: if true;  // Or restrict to authenticated users
      allow write: if false;
    }

    // No public access to stances
    match /stances/{stanceId} {
      allow read: if false;
      allow write: if false;
    }

    // No public access to events
    match /events/{eventId} {
      allow read: if false;
      allow write: if false;
    }
  }
}
```

### 10. Audit Trail

**Implemented:**
- ✅ All votes logged to `stances` collection
- ✅ All reward events logged to `events` collection
- ✅ Creator fee distributions logged

**Recommended additions:**
- Log all admin actions
- Log failed authentication attempts
- Set up anomaly detection alerts
- Export logs to external SIEM

## Security Monitoring

### Alerts to Configure:

1. **High Priority:**
   - Failed signature verifications (potential attack)
   - Deployer wallet balance < 1 SOL
   - Unusual vote patterns (>100 votes in 1 minute)
   - Creator fee claim failures

2. **Medium Priority:**
   - API usage approaching quota
   - Multiple failed admin key attempts
   - RPC connection failures

3. **Low Priority:**
   - Memory system showing high repetition
   - Cycle generation taking >30 seconds

### Monitoring Services:
- **Uptime:** UptimeRobot, Pingdom
- **Errors:** Sentry, Rollbar
- **Logs:** Datadog, New Relic
- **Security:** Snyk, Dependabot

## Deployment Checklist

Before deploying to production:

- [ ] All secrets in KMS/Secret Manager (not env files)
- [ ] Deployer wallet funded with ≥5 SOL
- [ ] Rate limiting tested and tuned
- [ ] Firestore security rules deployed
- [ ] Signature verification tested end-to-end
- [ ] Admin endpoints IP-restricted
- [ ] Monitoring and alerts configured
- [ ] Token gating tested (if enabled)
- [ ] Backup/restore procedure documented
- [ ] Incident response plan created

## Vulnerability Disclosure

If you discover a security vulnerability, please email security@kairo.xyz (replace with actual email).

**Do not:**
- Open public GitHub issues for security bugs
- Exploit vulnerabilities for personal gain
- Discuss vulnerabilities publicly before patch

## License & Compliance

- Ensure compliance with applicable data privacy laws (GDPR, CCPA)
- Wallet addresses may be considered personal data
- Implement data retention and deletion procedures
- Provide privacy policy to users
