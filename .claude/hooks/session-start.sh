#!/bin/bash
# career-ops SessionStart hook — Claude Code on the web.
#
# Reinstalls dependencies and re-scaffolds the gitignored user-layer files that
# career-ops needs in order to boot. The container is ephemeral and cv.md,
# config/profile.yml, portals.yml and data/ are all gitignored, so none of them
# survive into a new session; this rebuilds the shape of them each time.
#
# Idempotent and non-destructive: nothing here overwrites an existing file. The
# user layer is the candidate's own data, and clobbering it on a session resume
# would be data loss.
#
# What it writes is a SKELETON, not content. A hook has no Notion access, so the
# real CV and profile are re-hydrated by the agent from Notion
# (Work Station -> ABOUT ME -> "About Me" and "Official copy of resume").
# Scaffolded files carry a CAREER-OPS PLACEHOLDER sentinel until that happens.

set -euo pipefail

# Local checkouts manage their own setup; this hook is for the web only.
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"

YAML_SENTINEL='# CAREER-OPS PLACEHOLDER - not real data. Re-hydrate from Notion (Work Station > ABOUT ME) before generating any application.'
MD_SENTINEL='> **CAREER-OPS PLACEHOLDER** - not real data. Re-hydrate from Notion (Work Station > ABOUT ME) before generating any application.'

# --- 1. dependencies -------------------------------------------------------
# --ignore-scripts is deliberate: package.json's postinstall runs
# `npx playwright install chromium`, but Chromium is already baked into this
# image at $PLAYWRIGHT_BROWSERS_PATH. This matches what CI runs (test.yml).
# `install` rather than `ci` so the cached container state gets reused.
echo "[career-ops] installing dependencies..."
npm install --ignore-scripts

# --- 2. scaffold the user layer (copy-if-absent only) ----------------------
scaffold() { # scaffold <target> <source> [sentinel]
  local target="$1" source="$2" sentinel="${3:-}"
  [ -f "$target" ] && return 0
  [ -f "$source" ] || { echo "[career-ops] WARN: missing template $source"; return 0; }
  mkdir -p "$(dirname "$target")"
  if [ -n "$sentinel" ]; then
    { printf '%s\n' "$sentinel"; cat "$source"; } > "$target"
  else
    cp "$source" "$target"
  fi
  echo "[career-ops] scaffolded $target"
}

scaffold config/profile.yml config/profile.example.yml "$YAML_SENTINEL"
scaffold portals.yml templates/portals.example.yml

if [ ! -f data/applications.md ]; then
  mkdir -p data
  cat > data/applications.md << 'TRACKER_EOF'
# Applications Tracker

| # | Date | Company | Role | Score | Status | PDF | Report | Notes |
|---|------|---------|------|-------|--------|-----|--------|-------|
TRACKER_EOF
  echo "[career-ops] scaffolded data/applications.md"
fi

if [ ! -f cv.md ]; then
  { printf '%s\n\n' "$MD_SENTINEL"; cat << 'CV_EOF'
# Your Name

## Summary

## Experience

## Projects

## Education

## Skills
CV_EOF
  } > cv.md
  echo "[career-ops] scaffolded cv.md"
fi

# modes/_profile.md, modes/_custom.md, modes/_brief.md and voice-dna.md are
# deliberately not handled here — doctor.mjs onboardingState() already copies
# them from their .template.md siblings, and duplicating that would drift.

# --- 3. status report (never blocks) --------------------------------------
echo "[career-ops] doctor:"
node doctor.mjs --json || true

if grep -lq 'CAREER-OPS PLACEHOLDER' cv.md config/profile.yml 2>/dev/null; then
  echo ""
  echo "=============================================================="
  echo " career-ops is SCAFFOLDED but NOT PERSONALIZED."
  echo " cv.md / config/profile.yml still hold placeholder content."
  echo " Re-hydrate from Notion: Work Station > ABOUT ME"
  echo "   - 'About Me'               (narrative + proof points)"
  echo "   - 'Official copy of resume' (authoritative CV, PDF attachment)"
  echo " Do not generate any application until this is done."
  echo "=============================================================="
fi

# --- 4. Playwright sanity check (advisory only) ---------------------------
# playwright is pinned to 1.62.1 while the image ships its own Chromium build,
# so the revision can mismatch. PDF generation is optional; never fail here.
CHROMIUM_PATH="$(node -e "import('playwright').then(p=>console.log(p.chromium.executablePath())).catch(()=>process.exit(1))" 2>/dev/null || true)"
if [ -z "$CHROMIUM_PATH" ] || [ ! -e "$CHROMIUM_PATH" ]; then
  echo "[career-ops] WARN: Playwright's Chromium not found at '${CHROMIUM_PATH:-<unresolved>}'."
  echo "[career-ops]       PDF generation may need executablePath: '/opt/pw-browsers/chromium'."
fi

echo "[career-ops] session ready."
