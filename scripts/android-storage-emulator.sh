#!/usr/bin/env bash
set -euo pipefail
: "${RUNNER_TEMP:?Disposable runner temp required}"
: "${POSTGRES_TEST_URL:?Disposable PostgreSQL required}"
mkdir -p artifacts/android-smoke
STATE="$RUNNER_TEMP/android-storage-fixture.json"
node scripts/android-storage-server.mjs "$STATE" > artifacts/android-smoke/storage-server.log 2>&1 &
STORAGE_SERVER_PID=$!
trap 'kill "$STORAGE_SERVER_PID" 2>/dev/null || true; wait "$STORAGE_SERVER_PID" 2>/dev/null || true; rm -f "$STATE"' EXIT
for attempt in $(seq 1 100); do
  if [ -f "$STATE" ] && curl --fail --silent http://127.0.0.1:3002/health/ready > /dev/null; then break; fi
  kill -0 "$STORAGE_SERVER_PID"
  if [ "$attempt" -eq 100 ]; then echo 'Storage backend readiness timed out'; exit 1; fi
  sleep 0.2
done
adb reverse tcp:3002 tcp:3002
adb install -r android/app/build/outputs/apk/debug/app-debug.apk
adb install -r android/app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk
# No shell tracing: the argument contains temporary login credentials.
FIXTURE=$(node -e 'process.stdout.write(require("node:fs").readFileSync(process.argv[1]).toString("base64"))' "$STATE")
adb logcat -c
for phase in prepare finish; do
  adb shell am instrument -w -e class ru.liion.production.StorageBackendWebViewTest \
    -e storagePhase "$phase" -e storageFixture "$FIXTURE" \
    ru.liion.production.test/androidx.test.runner.AndroidJUnitRunner \
    > "artifacts/android-smoke/storage-$phase-instrumentation.txt"
  cat "artifacts/android-smoke/storage-$phase-instrumentation.txt"
  grep -q 'OK (1 test)' "artifacts/android-smoke/storage-$phase-instrumentation.txt"
  adb pull "/sdcard/Android/data/ru.liion.production/files/storage-backend-$phase.png" artifacts/android-smoke/
  adb shell uiautomator dump /sdcard/storage-backend-ui.xml
  adb pull /sdcard/storage-backend-ui.xml "artifacts/android-smoke/storage-$phase-ui.xml"
  # The runner and app process really die between phases; no data reset/uninstall.
  adb shell am force-stop ru.liion.production
  if [ "$phase" = prepare ]; then
    if adb shell pidof ru.liion.production; then echo 'Storage process did not terminate'; exit 1; fi
  fi
done
unset FIXTURE
adb logcat -d -v brief -s ProductionMfStorage:I '*:S' > artifacts/android-smoke/storage-result.log
node scripts/verify-android-storage.mjs "$STATE"
adb reverse --remove tcp:3002
