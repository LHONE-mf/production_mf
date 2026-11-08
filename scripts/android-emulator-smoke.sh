#!/usr/bin/env bash
set -euo pipefail

mkdir -p artifacts/android-smoke
PACKAGE="ru.liion.production"
ACTIVITY="ru.liion.production/.MainActivity"

adb wait-for-device
adb shell settings put system accelerometer_rotation 0
adb shell settings put system user_rotation 0
adb shell wm size 412x915
adb shell wm density 420
adb install -r android/app/build/outputs/apk/debug/app-debug.apk
adb logcat -c
adb shell am force-stop "$PACKAGE" || true
adb shell am start -W -n "$ACTIVITY"
sleep 12

adb shell screencap -p /sdcard/production-mf-launch.png
adb pull /sdcard/production-mf-launch.png artifacts/android-smoke/launch.png
adb shell uiautomator dump /sdcard/production-mf-ui.xml || true
adb pull /sdcard/production-mf-ui.xml artifacts/android-smoke/ui.xml || true
# Exercise the Android activity lifecycle, not just the first launch.
# A second cold launch detects failures in WebView/database initialization.
adb shell am force-stop "$PACKAGE"
adb shell am start -W -n "$ACTIVITY"
sleep 8
adb shell screencap -p /sdcard/production-mf-relaunch.png
adb pull /sdcard/production-mf-relaunch.png artifacts/android-smoke/relaunch.png
adb shell uiautomator dump /sdcard/production-mf-relaunch-ui.xml || true
adb pull /sdcard/production-mf-relaunch-ui.xml artifacts/android-smoke/relaunch-ui.xml || true
# Both Back presses must occur within the app's two-second exit window.
# Avoid screenshot pulls/dumpsys between presses: those can exceed the window.
adb shell 'input keyevent KEYCODE_BACK; input keyevent KEYCODE_BACK'
sleep 3
adb shell dumpsys window > artifacts/android-smoke/window-after-second-back.txt
if grep -E 'mCurrentFocus|mFocusedApp|topResumedActivity' artifacts/android-smoke/window-after-second-back.txt | grep -q "$PACKAGE"; then
  echo 'ERROR: Two consecutive Back presses did not exit Production MF' >&2
  exit 1
fi

# Reopen and verify a single Back does not exit the app.
adb shell am start -W -n "$ACTIVITY"
sleep 3
adb shell input keyevent KEYCODE_BACK
sleep 1
adb shell dumpsys window > artifacts/android-smoke/window.txt
adb shell screencap -p /sdcard/production-mf-after-back.png
adb pull /sdcard/production-mf-after-back.png artifacts/android-smoke/after-back.png
adb logcat -d -v time > artifacts/android-smoke/logcat.txt
adb shell pidof "$PACKAGE" > artifacts/android-smoke/pid.txt
grep -E "mCurrentFocus|mFocusedApp|topResumedActivity" artifacts/android-smoke/window.txt > artifacts/android-smoke/focus.txt || true
if ! grep -q "$PACKAGE" artifacts/android-smoke/focus.txt; then
  echo "ERROR: Production MF exited after a single Back press." >&2
  exit 1
fi
if grep -E "FATAL EXCEPTION|Process: $PACKAGE.*|ANR in $PACKAGE" artifacts/android-smoke/logcat.txt > artifacts/android-smoke/crashes.txt; then
  echo "ERROR: Android crash detected. See crashes.txt" >&2
  exit 1
fi
echo "Emulator smoke test passed after first launch and cold relaunch. Inspect launch.png and relaunch.png."
