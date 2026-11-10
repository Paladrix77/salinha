// Roda no GitHub Actions depois do "npx cap add android":
// copia o código nativo da Salinha e ajusta permissões no AndroidManifest.
import fs from "node:fs";
import path from "node:path";

const raiz = path.dirname(new URL(import.meta.url).pathname);
const javaDir = path.join(raiz, "android/app/src/main/java/com/salinha/app");
fs.mkdirSync(javaDir, { recursive: true });
for (const f of ["MainActivity.java", "ChamadaPlugin.java", "ChamadaService.java"]) {
  fs.copyFileSync(path.join(raiz, "nativo", f), path.join(javaDir, f));
  console.log("copiado:", f);
}

const manifestPath = path.join(raiz, "android/app/src/main/AndroidManifest.xml");
let m = fs.readFileSync(manifestPath, "utf8");

const permissoes = [
  "android.permission.RECORD_AUDIO",
  "android.permission.CAMERA",
  "android.permission.MODIFY_AUDIO_SETTINGS",
  "android.permission.FOREGROUND_SERVICE",
  "android.permission.FOREGROUND_SERVICE_MICROPHONE",
  "android.permission.FOREGROUND_SERVICE_MEDIA_PLAYBACK",
  "android.permission.POST_NOTIFICATIONS",
  "android.permission.WAKE_LOCK",
  "android.permission.ACCESS_NETWORK_STATE",
  "android.permission.ACCESS_WIFI_STATE",
  "android.permission.BLUETOOTH_CONNECT",
];
const faltando = permissoes.filter((p) => !m.includes(`"${p}"`));
const linhas = faltando.map((p) => `    <uses-permission android:name="${p}" />`).join("\n");
m = m.replace(/(\s*<\/manifest>)/, `\n${linhas}\n    <uses-feature android:name="android.hardware.camera" android:required="false" />\n    <uses-feature android:name="android.hardware.microphone" android:required="false" />$1`);

const servico = `        <service android:name=".ChamadaService" android:exported="false" android:foregroundServiceType="microphone|mediaPlayback" />\n`;
if (!m.includes("ChamadaService")) m = m.replace(/(\s*<\/application>)/, `\n${servico}$1`);

// Telinha flutuante (PiP) na tela principal
if (!m.includes("supportsPictureInPicture")) {
  m = m.replace(/<activity(\s)/, '<activity android:supportsPictureInPicture="true" android:resizeableActivity="true"$1');
}

fs.writeFileSync(manifestPath, m);
console.log("AndroidManifest ajustado (+" + faltando.length + " permissões, serviço da call)");
