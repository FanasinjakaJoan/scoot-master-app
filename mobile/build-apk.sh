#!/usr/bin/env bash
# Scoot Master — Build APK Android local
# Prérequis : Node 22, Java 17, Android SDK (ANDROID_HOME), Gradle wrapper
# Usage :
#   ./build-apk.sh
#   EXPO_PUBLIC_API_URL=https://scoot-master-api.onrender.com ./build-apk.sh
#   EXPO_PUBLIC_API_URL=http://192.168.1.20:4000 ./build-apk.sh

set -e

API_URL="${EXPO_PUBLIC_API_URL:-https://scoot-master-api.onrender.com}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "🏍️  Scoot Master — Build APK"
echo "   API URL : $API_URL"
echo "   Dossier : $SCRIPT_DIR"
echo ""

# Vérifications
if ! command -v node >/dev/null 2>&1; then
  echo "❌ Node.js non trouvé (≥20 requis)"
  exit 1
fi
if ! command -v java >/dev/null 2>&1; then
  echo "❌ Java non trouvé (17 requis) — installez Temurin 17"
  echo "   https://adoptium.net/temurin/releases/?version=17"
  exit 1
fi
JAVA_VER=$(java -version 2>&1 | head -n 1 | cut -d'"' -f2 | cut -d'.' -f1)
echo "   Node : $(node -v) | Java : $(java -version 2>&1 | head -n 1) | NPM : $(npm -v)"

if [ -z "$ANDROID_HOME" ] && [ -z "$ANDROID_SDK_ROOT" ]; then
  echo "⚠️  ANDROID_HOME non défini, tentative auto-détection..."
  for CANDIDATE in "$HOME/Library/Android/sdk" "$HOME/Android/Sdk" "/usr/local/lib/android/sdk" "$HOME/AppData/Local/Android/Sdk"; do
    if [ -d "$CANDIDATE" ]; then
      export ANDROID_HOME="$CANDIDATE"
      echo "   ANDROID_HOME auto-détecté : $ANDROID_HOME"
      break
    fi
  done
fi

if [ -z "$ANDROID_HOME" ]; then
  echo "❌ ANDROID_HOME non défini et SDK non trouvé"
  echo "   Installez Android Studio et définissez ANDROID_HOME"
  exit 1
fi

echo ""
echo "📦 Installation dépendances (npm ci)..."
npm ci

echo ""
echo "🔨 Expo prebuild --platform android --clean..."
EXPO_PUBLIC_API_URL="$API_URL" npx expo prebuild --platform android --clean --no-install

echo ""
echo "🤖 Build Gradle assembleRelease..."
cd android
chmod +x gradlew
./gradlew assembleRelease --no-daemon -x lint

echo ""
echo "📋 APK générés :"
find app/build/outputs/apk/release -name "*.apk" -type f -exec ls -lh {} \;

APK_PATH=$(find app/build/outputs/apk/release -name "*.apk" | head -n 1)
if [ -n "$APK_PATH" ]; then
  cp "$APK_PATH" "$SCRIPT_DIR/scoot-master-latest.apk"
  cp "$APK_PATH" "$SCRIPT_DIR/scoot-master-$(date +%Y%m%d-%H%M%S).apk"
  echo ""
  echo "✅ APK copié :"
  ls -lh "$SCRIPT_DIR"/scoot-master-*.apk
  echo ""
  echo "📱 Pour installer :"
  echo "   adb install $SCRIPT_DIR/scoot-master-latest.apk"
  echo "   ou transférez l'APK sur le téléphone et ouvrez-le"
else
  echo "❌ APK non trouvé"
  exit 1
fi
