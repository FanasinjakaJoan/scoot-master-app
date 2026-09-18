# 📱 Build APK Android — Scoot Master

Ce guide explique comment builder l'application mobile **Scoot Master** en **APK Android** installable.

---

## 1. Informations APK

| Champ | Valeur |
|---|---|
| **Package** | `mg.scootmaster.app` |
| **Nom** | Scoot Master |
| **Version** | `1.0.0` (versionCode auto-incrémenté par EAS) |
| **Min SDK** | 24 (Android 7.0) |
| **Target SDK** | 35 (Android 15) |
| **Permissions** | `READ_MEDIA_IMAGES` (galerie photos motos) |
| **API URL par défaut** | `https://scoot-master-api.onrender.com` (configurable via `EXPO_PUBLIC_API_URL`) |
| **Taille APK Release** | ~50-120 MB (Hermes + expo-sqlite + assets) |

---

## 2. Méthodes de build

### Méthode A : GitHub Actions (recommandée, sans SDK local)

Le workflow `.github/workflows/apk.yml` build l'APK automatiquement sur les runners GitHub (qui ont Android SDK + Java 17 préinstallés).

**Déclenchement automatique :**
- Push sur `main` touchant `mobile/**` → build APK + upload en artifact

**Déclenchement manuel :**
1. Allez sur https://github.com/FanasinjakaJoan/scoot-master-app/actions/workflows/apk.yml
2. `Run workflow` → branche `main` → `api_url` = `https://scoot-master-api.onrender.com` → `Run`
3. Attendez 10-15 min (Gradle build)
4. Ouvrez le run → section **Artifacts** → téléchargez `scoot-master-apk` (contient `scoot-master-latest.apk` + `scoot-master-<sha>.apk`)

**Dernière build réussie :**
- Run ID `35310581956` : https://github.com/FanasinjakaJoan/scoot-master-app/actions/runs/35310581956
- Artifact : `scoot-master-apk` (112 MB, 2 APKs)
- Commit : `030e887` (fix workflow Android SDK)

> Si le téléchargement d'artifact échoue via `gh CLI` dans certains environnements (blob storage Azure bloqué), utilisez directement l'interface web GitHub dans votre navigateur.

**Installation de l'APK :**
```bash
adb install scoot-master-latest.apk
# ou transférez le fichier sur le téléphone et ouvrez-le (autoriser sources inconnues)
```

### Méthode B : Build local avec Gradle (nécessite Android Studio)

Prérequis :
- Node.js ≥20, Java 17 (Temurin), Android Studio + SDK (API 35), `ANDROID_HOME` défini

```bash
cd mobile
npm ci

# Génère le dossier android/ natif (Expo prebuild)
EXPO_PUBLIC_API_URL=https://scoot-master-api.onrender.com npx expo prebuild --platform android --clean

# Build Release APK
cd android
./gradlew assembleRelease --no-daemon -x lint

# APK généré :
# android/app/build/outputs/apk/release/app-release.apk
ls -lh app/build/outputs/apk/release/
```

**Script tout-en-un :**
```bash
cd mobile
chmod +x build-apk.sh
./build-apk.sh
# ou
EXPO_PUBLIC_API_URL=https://scoot-master-api.onrender.com ./build-apk.sh
```

Le script `build-apk.sh` (fourni) fait :
1. `npm ci`
2. `expo prebuild --clean`
3. `gradlew assembleRelease`
4. Copie l'APK en `scoot-master-latest.apk` à la racine `mobile/`

### Méthode C : EAS Build (cloud Expo, sans SDK local, nécessite compte Expo)

Prérequis : compte https://expo.dev + `eas-cli` + `EXPO_TOKEN` (optionnel en CI)

```bash
cd mobile
npm install -g eas-cli
eas login
eas build:configure # génère eas.json si absent (déjà présent)

# Build APK preview (internal distribution)
EXPO_PUBLIC_API_URL=https://scoot-master-api.onrender.com eas build --platform android --profile preview

# Build APK production (store)
eas build --platform android --profile production
```

Configuration `eas.json` (déjà fournie) :

```json
{
  "build": {
    "preview": {
      "distribution": "internal",
      "android": { "buildType": "apk" },
      "env": { "EXPO_PUBLIC_API_URL": "https://scoot-master-api.onrender.com" }
    },
    "production": {
      "android": { "buildType": "apk" },
      "env": { "EXPO_PUBLIC_API_URL": "https://scoot-master-api.onrender.com" }
    }
  }
}
```

- `preview` : APK installable directement, distribution interne
- `production` : APK/AAB pour Play Store (si vous mettez `buildType: app-bundle` pour AAB)

Les builds EAS sont visibles sur https://expo.dev/accounts/[votre-compte]/projects/scoot-master-app/builds

### Méthode D : Expo Go (développement, pas d'APK)

Pour tester sans builder d'APK :

```bash
cd mobile
npm ci
EXPO_PUBLIC_API_URL=https://scoot-master-api.onrender.com npx expo start
# Scanner QR code avec Expo Go (Android/iOS)
```

---

## 3. Configuration API dans l'APK

L'APK embarque l'URL de l'API au build via `EXPO_PUBLIC_API_URL` :

| Environnement | URL API | Commande |
|---|---|---|
| **Prod Render** | `https://scoot-master-api.onrender.com` | `EXPO_PUBLIC_API_URL=https://scoot-master-api.onrender.com eas build --profile production` |
| **Local** | `http://10.0.2.2:4000` (émulateur) | `EXPO_PUBLIC_API_URL=http://10.0.2.2:4000 npx expo prebuild` |
| **Réseau local** | `http://192.168.1.20:4000` | `EXPO_PUBLIC_API_URL=http://192.168.1.20:4000 ...` |

Fichier source : `mobile/src/lib/config.ts` lit `process.env.EXPO_PUBLIC_API_URL`, fallback `http://10.0.2.2:4000`.

Pour changer l'URL sans rebuild, il faudrait implémenter un écran de config dans l'app (pas encore fait).

---

## 4. Signature APK (Release)

Par défaut, Gradle signe l'APK en debug si pas de keystore. Pour une Release signée Play Store :

1. Générez un keystore :
```bash
keytool -genkeypair -v -storetype PKCS12 -keystore scoot-master.keystore -alias scoot-master -keyalg RSA -keysize 2048 -validity 10000
```

2. Configurez `android/gradle.properties` :
```properties
MYAPP_UPLOAD_STORE_FILE=scoot-master.keystore
MYAPP_UPLOAD_KEY_ALIAS=scoot-master
MYAPP_UPLOAD_STORE_PASSWORD=*****
MYAPP_UPLOAD_KEY_PASSWORD=*****
```

3. `android/app/build.gradle` lit déjà ces props (généré par Expo prebuild).

4. Build :
```bash
cd android && ./gradlew assembleRelease
```

> Pour EAS Build, la signature est gérée automatiquement par Expo (credentials cloud).

---

## 5. Dépannage

| Erreur | Solution |
|---|---|
| `SDK location not found` | Définissez `ANDROID_HOME=/Users/.../Library/Android/sdk` ou `C:\Users\...\AppData\Local\Android\Sdk`, ou `echo "sdk.dir=$ANDROID_HOME" > android/local.properties` |
| `Task :app:compileReleaseKotlin FAILED` | Java 17 requis, pas 21. `java -version` doit afficher 17. Utilisez `sdkman` ou `actions/setup-java@v5` avec `java-version: 17` |
| `Could not determine Java version` | Gradle 8.x nécessite Java 17. Mettez à jour `android/gradle/wrapper/gradle-wrapper.properties` → `gradle-8.10-all.zip` (fait par Expo) |
| `expo prebuild` échoue `userInterfaceStyle` | Installez `expo-system-ui` ou ignorez le warning, c'est non bloquant |
| APK trop gros (>150 MB) | Normal avec Hermes + expo-sqlite WASM + assets. Activez `android/app/build.gradle` → `enableShrinkResources true`, `minifyEnabled true` (Expo le fait en release) |
| App crash au démarrage | Vérifiez `adb logcat`, souvent `EXPO_PUBLIC_API_URL` invalide ou API injoignable. Testez `curl https://scoot-master-api.onrender.com/api/health` depuis le téléphone |
| `INSTALL_FAILED_UPDATE_INCOMPATIBLE` | Désinstallez l'ancienne version avec signature différente : `adb uninstall mg.scootmaster.app` |

---

## 6. Checklist avant distribution

- [ ] `app.json` : `version` bumpée, `android.package` = `mg.scootmaster.app`, `versionCode` auto-incrémenté (EAS) ou manuellement dans `android/app/build.gradle`
- [ ] `EXPO_PUBLIC_API_URL` pointe vers prod Render (`https://scoot-master-api.onrender.com`)
- [ ] Tests : `cd mobile && npm test && npx tsc --noEmit`
- [ ] Build APK Release via GitHub Actions ou local Gradle
- [ ] Test sur vrai appareil : login `admin/admin123`, catalogue, création moto offline, sync
- [ ] Signature Release (keystore) si distribution Play Store
- [ ] Upload sur GitHub Releases ou Play Console
- [ ] Documentation : URL API, comptes démo, procédure d'install

---

## 7. Liens

- Workflow APK : `.github/workflows/apk.yml`
- Config EAS : `mobile/eas.json`
- Script local : `mobile/build-apk.sh`
- Expo docs : https://docs.expo.dev/build/setup/ + https://docs.expo.dev/build/eas-json/
- Android Gradle : https://developer.android.com/build
- Dernière build réussie (Actions) : https://github.com/FanasinjakaJoan/scoot-master-app/actions/runs/35310581956 (artifact `scoot-master-apk`, 112 MB)
