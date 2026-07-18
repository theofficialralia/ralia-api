#!/usr/bin/env bash
#
# End-to-end verification of the Ralia loop, driven entirely through the public
# API. This is the evidence for the Phase-2 gate (handoff §10): every step below
# is a real HTTP call against a running server, and the money assertions are read
# back out of the ledger.
#
#   register client + promoter -> profile + channel -> admin approves promoter
#   -> create + price + fund campaign -> candidates -> offer -> accept
#   -> click the tracking link -> submit proof -> admin approves
#   -> ledger pays the promoter -> withdraw -> admin records the payout
#
# Usage:  make verify-loop     (or)  ./scripts/verify-loop.sh [base_url]
# Exits non-zero on the first failed assertion.

set -uo pipefail
cd "$(dirname "$0")/.."

BASE="${1:-http://localhost:3000}"
API="$BASE/v1"
JSON='Content-Type: application/json'
OTP_LOG="${DEV_OTP_LOG:-.dev-otp.log}"

# Colour only on a terminal, so a redirected run (make gate) produces a clean,
# readable evidence file rather than one full of escape codes.
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  RED=$'\033[31m'; GREEN=$'\033[32m'; DIM=$'\033[2m'; BOLD=$'\033[1m'; OFF=$'\033[0m'
else
  RED=''; GREEN=''; DIM=''; BOLD=''; OFF=''
fi
FAILURES=0
STEP=0

step() { STEP=$((STEP + 1)); printf "\n%s%2d. %s%s\n" "$BOLD" "$STEP" "$1" "$OFF"; }
ok()   { printf "    %s✓%s %s\n" "$GREEN" "$OFF" "$1"; }
fail() { printf "    %s✗%s %s\n" "$RED" "$OFF" "$1"; FAILURES=$((FAILURES + 1)); }
note() { printf "    %s%s%s\n" "$DIM" "$1" "$OFF"; }

# assert <actual> <expected> <description>
assert() {
  if [ "$1" = "$2" ]; then ok "$3"; else fail "$3 — expected '$2', got '$1'"; fi
}

# Extract a field from JSON on stdin, e.g.  echo "$r" | field ".id"
field() { node -pe "try{const v=JSON.parse(require('fs').readFileSync(0))$1; v===undefined?'':v}catch(e){''}"; }

psql_x() { docker compose exec -T postgres psql -U ralia -d ralia -tAqc "$1" 2>/dev/null | tr -d ' '; }

# The dev console OTP provider appends codes here (never enabled in production).
otp_for() {
  for _ in $(seq 1 20); do
    code=$(grep -F "$1 PHONE_VERIFY " "$OTP_LOG" 2>/dev/null | tail -1 | awk '{print $3}')
    [ -n "$code" ] && { echo "$code"; return 0; }
    sleep 0.25
  done
  return 1
}

# ── Preflight ────────────────────────────────────────────────
printf "%sRalia — end-to-end loop verification%s\n" "$BOLD" "$OFF"
printf "%s%s  ·  %s%s\n" "$DIM" "$BASE" "$(date -u '+%Y-%m-%d %H:%M:%S UTC')" "$OFF"

if ! curl -fsS "$BASE/health" >/dev/null 2>&1; then
  printf "\n%s✗ No server at %s — start it with 'make dev'.%s\n" "$RED" "$BASE" "$OFF"
  exit 1
fi
if [ ! -w "$(dirname "$OTP_LOG")" ]; then
  printf "\n%s✗ Cannot read %s. Set DEV_OTP_LOG and restart the server.%s\n" "$RED" "$OTP_LOG" "$OFF"
  exit 1
fi

SUFFIX=$(( RANDOM % 900000 + 100000 ))
CLIENT_PHONE="+2348011$SUFFIX"
PROMOTER_PHONE="+2348022$(( SUFFIX + 1 ))"
CLIENT_EMAIL="client.$SUFFIX@verify.local"
PROMOTER_EMAIL="promoter.$SUFFIX@verify.local"
PASSWORD="a long enough passphrase"

# Sized so the promoter's fee clears the ₦5,000 withdrawal minimum, exercising
# the whole payout path rather than stopping at "below minimum".
CLAIMED_AUDIENCE=5000000
MIN_REACH=250000

# ── 1. Registration ──────────────────────────────────────────
step "Register a client and a promoter"

# Registration is rate-limited (5/min) — correctly so. Report that plainly rather
# than letting it surface later as a mystifying "no OTP arrived".
register() { # <payload> <label>
  local status
  status=$(curl -sS -o /dev/null -w "%{http_code}" -X POST "$API/auth/register" -H "$JSON" -d "$1")
  if [ "$status" = "429" ]; then
    fail "$2 registration was rate-limited (429). This script registers two accounts per run; wait a minute between runs."
    exit 1
  fi
  if [ "$status" != "201" ]; then fail "$2 registration returned $status"; exit 1; fi
}
register "{\"email\":\"$CLIENT_EMAIL\",\"phone_e164\":\"$CLIENT_PHONE\",\"password\":\"$PASSWORD\",\"role\":\"CLIENT\",\"org_name\":\"Verify Threads $SUFFIX\",\"accepted_terms\":true,\"accepted_privacy\":true}" "client"
register "{\"email\":\"$PROMOTER_EMAIL\",\"phone_e164\":\"$PROMOTER_PHONE\",\"password\":\"$PASSWORD\",\"role\":\"PROMOTER\",\"accepted_terms\":true,\"accepted_privacy\":true}" "promoter"

CLIENT_CODE=$(otp_for "$CLIENT_PHONE") || { fail "no OTP reached $OTP_LOG for the client — is DEV_OTP_LOG set and the server restarted since?"; exit 1; }
PROMOTER_CODE=$(otp_for "$PROMOTER_PHONE") || { fail "no OTP reached $OTP_LOG for the promoter"; exit 1; }
CLIENT_TOKEN=$(curl -sS -X POST "$API/auth/otp/verify" -H "$JSON" -d "{\"phone_e164\":\"$CLIENT_PHONE\",\"code\":\"$CLIENT_CODE\"}" | field ".access_token")
PROMOTER_TOKEN=$(curl -sS -X POST "$API/auth/otp/verify" -H "$JSON" -d "{\"phone_e164\":\"$PROMOTER_PHONE\",\"code\":\"$PROMOTER_CODE\"}" | field ".access_token")

[ -n "$CLIENT_TOKEN" ] && ok "client registered and phone verified" || fail "client verification failed"
[ -n "$PROMOTER_TOKEN" ] && ok "promoter registered and phone verified" || fail "promoter verification failed"
[ -n "$CLIENT_TOKEN" ] && [ -n "$PROMOTER_TOKEN" ] || exit 1
CLIENT_AUTH="Authorization: Bearer $CLIENT_TOKEN"
PROMOTER_AUTH="Authorization: Bearer $PROMOTER_TOKEN"

# ── 2. Promoter profile ──────────────────────────────────────
step "Promoter completes the questionnaire, a channel and bank details"
curl -sS -X PUT "$API/promoters/me/profile" -H "$PROMOTER_AUTH" -H "$JSON" \
  -d '{"full_name":"Ada Verification","dob":"1996-04-12","location_state":"Lagos","languages_spoken":["English"],"preferred_categories":["Fashion"]}' >/dev/null
REACH=$(curl -sS -X POST "$API/promoters/me/channels" -H "$PROMOTER_AUTH" -H "$JSON" \
  -d "{\"platform\":\"INSTAGRAM\",\"handle\":\"@ada\",\"claimed_audience\":$CLAIMED_AUDIENCE}" | field ".effective_reach")
curl -sS -X POST "$API/promoters/me/bank" -H "$PROMOTER_AUTH" -H "$JSON" \
  -d '{"bank_code":"058","account_number":"0123456789","account_name":"ADA VERIFICATION"}' >/dev/null

# §5.1: 5,000,000 x 0.10 (instagram) x 0.6 (SELF) = 300,000
assert "$REACH" "300000" "effective reach computed server-side: $REACH"
PROFILE_STATUS=$(curl -sS "$API/promoters/me/profile" -H "$PROMOTER_AUTH" | field ".status")
assert "$PROFILE_STATUS" "AWAITING_APPROVAL" "profile complete, awaiting approval"

# ── 3. Admin approval ────────────────────────────────────────
step "Admin approves the promoter"
ADMIN_ID=$(psql_x "SELECT id FROM users WHERE email='admin@ralia.test';")
[ -n "$ADMIN_ID" ] || { fail "no seeded admin — run 'make seed'"; exit 1; }
SECRET=$(grep '^JWT_ACCESS_SECRET=' .env | cut -d= -f2)
ADMIN_TOKEN=$(node -e "console.log(require('jsonwebtoken').sign({sub:'$ADMIN_ID',roles:['ADMIN']},'$SECRET',{expiresIn:'30m'}))")
ADMIN_AUTH="Authorization: Bearer $ADMIN_TOKEN"
PROMOTER_ID=$(psql_x "SELECT id FROM users WHERE email='$PROMOTER_EMAIL';")

APPROVED=$(curl -sS -X POST "$API/admin/promoters/$PROMOTER_ID/approve" -H "$ADMIN_AUTH" | field ".status")
assert "$APPROVED" "ACTIVE" "promoter approved and channels activated"

# ── 4. Campaign ──────────────────────────────────────────────
step "Client creates, targets and prices a campaign"
CAMPAIGN_ID=$(curl -sS -X POST "$API/campaigns" -H "$CLIENT_AUTH" -H "$JSON" \
  -d '{"name":"Verification Campaign","objective":"AWARENESS","destination_url":"https://threads.example/shop","slots_total":1}' | field ".id")
curl -sS -X PUT "$API/campaigns/$CAMPAIGN_ID/targeting" -H "$CLIENT_AUTH" -H "$JSON" \
  -d "{\"states\":[\"Lagos\"],\"platforms\":[\"INSTAGRAM\"],\"min_effective_reach\":$MIN_REACH}" >/dev/null
QUOTE=$(curl -sS -X POST "$API/campaigns/$CAMPAIGN_ID/quote" -H "$CLIENT_AUTH")
PRICE=$(echo "$QUOTE" | field ".price.amount_minor")
FEE=$(echo "$QUOTE" | field ".promoter_fee.amount_minor")
ELIGIBLE=$(echo "$QUOTE" | field ".eligible_promoters")

# §5.2: (250000/1000) x 3000 RPM x 1.0 awareness x 1.15 (3 filters) = 862,500
assert "$PRICE" "862500" "quoted price $(echo "$QUOTE" | field ".price.amount_display")"
assert "$FEE" "603750" "promoter fee $(echo "$QUOTE" | field ".promoter_fee.amount_display") (70% after the 30% take)"
[ "$ELIGIBLE" -ge 1 ] && ok "$ELIGIBLE promoter(s) match the targeting" || fail "no eligible promoters"
curl -sS -X POST "$API/campaigns/$CAMPAIGN_ID/submit" -H "$CLIENT_AUTH" >/dev/null
ok "submitted for approval"

# ── 5. Funding ───────────────────────────────────────────────
step "Admin approves the campaign and records the client's transfer"
curl -sS -X POST "$API/admin/campaigns/$CAMPAIGN_ID/approve" -H "$ADMIN_AUTH" >/dev/null
FUNDED=$(curl -sS -X POST "$API/admin/campaigns/$CAMPAIGN_ID/fund" -H "$ADMIN_AUTH" -H "$JSON" \
  -H "Idempotency-Key: $(uuidgen)" -d "{\"amount_minor\":$PRICE,\"reference\":\"VERIFY-$SUFFIX\"}" | field ".status")
assert "$FUNDED" "LIVE" "funding recorded, campaign is LIVE"
note "DR BANK_CLEARING / CR CAMPAIGN_ESCROW — no payment gateway is in scope (§11)"

# ── 6. Matching ──────────────────────────────────────────────
step "Admin reviews candidates and sends an offer; promoter accepts"
CANDIDATES=$(curl -sS "$API/campaigns/$CAMPAIGN_ID/candidates" -H "$ADMIN_AUTH" | field ".length")
[ "$CANDIDATES" -ge 1 ] && ok "$CANDIDATES candidate(s) passed the §5.3 hard filter" || fail "no candidates"
curl -sS -X POST "$API/campaigns/$CAMPAIGN_ID/offers" -H "$ADMIN_AUTH" -H "$JSON" \
  -d "{\"promoter_ids\":[\"$PROMOTER_ID\"]}" >/dev/null
OFFER_ID=$(curl -sS "$API/offers" -H "$PROMOTER_AUTH" | field "[0].id")
[ -n "$OFFER_ID" ] && ok "offer received by the promoter" || fail "promoter sees no offer"
ACCEPT=$(curl -sS -X POST "$API/offers/$OFFER_ID/accept" -H "$PROMOTER_AUTH")
TRACKING_TOKEN=$(echo "$ACCEPT" | field ".tracking_token")
ASSIGNMENT_ID=$(echo "$ACCEPT" | field ".id")
[ -n "$TRACKING_TOKEN" ] && ok "offer accepted, slot reserved, tracking link issued" || fail "accept failed"

# ── 7. Tracking ──────────────────────────────────────────────
step "Someone clicks the promoter's tracking link"
REDIRECT=$(curl -sS -o /dev/null -w "%{http_code}" "$BASE/r/$TRACKING_TOKEN" -H "User-Agent: Mozilla/5.0 (iPhone)")
assert "$REDIRECT" "302" "redirect $REDIRECT to the campaign destination"
CLICKS=$(psql_x "SELECT count(*) FROM click_events WHERE token='$TRACKING_TOKEN';")
assert "$CLICKS" "1" "click recorded (IP and user-agent stored only as salted hashes)"

# ── 8. Proof ─────────────────────────────────────────────────
step "Promoter submits proof of posting"
PROOF=$(mktemp -t ralia-proof).png
# The screenshot must be structurally different from previous runs', not merely a
# brightness shift: a perceptual hash ignores overall brightness by design, so
# recolouring the same pattern would (correctly) be flagged as a duplicate. Vary
# the spatial frequency and geometry instead.
node -e "
const sharp=require('sharp');const w=300,h=300,c=3;const b=Buffer.alloc(w*h*c);
const s=$SUFFIX, bs=12+(s%37), sx=1+(s%7), sy=1+((s>>3)%5), rot=(s%4);
for(let y=0;y<h;y++)for(let x=0;x<w;x++){
  const i=(y*w+x)*c;
  const u=rot%2?x:y, v=rot%2?y:x;
  const k=Math.floor(u/bs)*sx + Math.floor(v/bs)*sy;
  b[i]=(k*83+s)%256;
  b[i+1]=((u*sx)^(v*sy))%256;
  b[i+2]=((u+v)*(1+s%11))%256;
}
sharp(b,{raw:{width:w,height:h,channels:c}}).png().toFile('$PROOF');" 2>/dev/null
SUBMISSION=$(curl -sS -X POST "$API/assignments/$ASSIGNMENT_ID/submission" -H "$PROMOTER_AUTH" \
  -F "file=@$PROOF;type=image/png" -F "note=Posted to my feed")
SUBMISSION_ID=$(echo "$SUBMISSION" | field ".id")
assert "$(echo "$SUBMISSION" | field ".verdict")" "PENDING" "submission queued for review"
assert "$(echo "$SUBMISSION" | field ".auto_flag")" "false" "screenshot is not a perceptual duplicate"
note "nothing auto-approves — every submission reaches a human (§5.5)"
rm -f "$PROOF"

# ── 9. Approval and payout ───────────────────────────────────
step "Admin approves the proof and the ledger pays the promoter"
curl -sS -X POST "$API/admin/submissions/$SUBMISSION_ID/approve" -H "$ADMIN_AUTH" \
  -H "Idempotency-Key: $(uuidgen)" >/dev/null
BALANCE=$(curl -sS "$API/wallet" -H "$PROMOTER_AUTH" | field ".available.amount_minor")
assert "$BALANCE" "$FEE" "promoter balance is $(curl -sS "$API/wallet" -H "$PROMOTER_AUTH" | field ".available.amount_display")"

LEGS=$(psql_x "SELECT count(*) FROM ledger_entries e JOIN ledger_transactions t ON t.id=e.transaction_id WHERE t.kind='SUBMISSION_PAYOUT' AND t.reference_id='$SUBMISSION_ID';")
DEBITS=$(psql_x "SELECT COALESCE(sum(amount_minor),0) FROM ledger_entries e JOIN ledger_transactions t ON t.id=e.transaction_id WHERE t.kind='SUBMISSION_PAYOUT' AND t.reference_id='$SUBMISSION_ID' AND direction='DEBIT';")
CREDITS=$(psql_x "SELECT COALESCE(sum(amount_minor),0) FROM ledger_entries e JOIN ledger_transactions t ON t.id=e.transaction_id WHERE t.kind='SUBMISSION_PAYOUT' AND t.reference_id='$SUBMISSION_ID' AND direction='CREDIT';")
assert "$LEGS" "3" "fee and take left escrow in ONE transaction ($LEGS legs)"
assert "$DEBITS" "$CREDITS" "that transaction balances: debits $DEBITS = credits $CREDITS"

# ── 10. Withdrawal ───────────────────────────────────────────
step "Promoter withdraws; admin records the payout"
WITHDRAWAL_ID=$(curl -sS -X POST "$API/withdrawals" -H "$PROMOTER_AUTH" -H "$JSON" \
  -d "{\"amount_minor\":$FEE}" | field ".id")
[ -n "$WITHDRAWAL_ID" ] && ok "withdrawal requested" || fail "withdrawal request failed"
curl -sS -X POST "$API/admin/withdrawals/$WITHDRAWAL_ID/approve" -H "$ADMIN_AUTH" >/dev/null
PAID=$(curl -sS -X POST "$API/admin/withdrawals/$WITHDRAWAL_ID/record-paid" -H "$ADMIN_AUTH" -H "$JSON" \
  -H "Idempotency-Key: $(uuidgen)" -d "{\"paid_ref\":\"VERIFY-PAYOUT-$SUFFIX\"}" | field ".status")
assert "$PAID" "PAID" "payout recorded"
FINAL=$(curl -sS "$API/wallet" -H "$PROMOTER_AUTH" | field ".available.amount_minor")
assert "$FINAL" "0" "promoter balance returns to zero"

# ── 11. The books ────────────────────────────────────────────
step "The books close and every decision is audited"
CASH=$(psql_x "SELECT COALESCE(SUM(CASE WHEN e.direction='DEBIT' THEN e.amount_minor ELSE -e.amount_minor END),0) FROM ledger_entries e JOIN accounts a ON a.id=e.account_id WHERE a.kind='BANK_CLEARING';")
OWED=$(psql_x "SELECT COALESCE(SUM(CASE WHEN e.direction='CREDIT' THEN e.amount_minor ELSE -e.amount_minor END),0) FROM ledger_entries e JOIN accounts a ON a.id=e.account_id WHERE a.kind<>'BANK_CLEARING';")
assert "$CASH" "$OWED" "cash held ($CASH) = everything owed plus earned ($OWED)"

for action in promoter.approve campaign.approve campaign.fund submission.approve withdrawal.approve withdrawal.paid; do
  n=$(psql_x "SELECT count(*) FROM audit_log WHERE action='$action';")
  [ "$n" -ge 1 ] && ok "audited: $action" || fail "no audit row for $action"
done

# ── Result ───────────────────────────────────────────────────
printf "\n"
if [ "$FAILURES" -eq 0 ]; then
  printf "%s  LOOP VERIFIED — all assertions passed  %s\n" "$GREEN$BOLD" "$OFF"
  printf "%s  %s%s\n\n" "$DIM" "$(date -u '+%Y-%m-%d %H:%M:%S UTC')" "$OFF"
  exit 0
fi
printf "%s  %d ASSERTION(S) FAILED  %s\n\n" "$RED$BOLD" "$FAILURES" "$OFF"
exit 1
