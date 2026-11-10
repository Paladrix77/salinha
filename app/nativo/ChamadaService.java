package com.salinha.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;

import androidx.core.app.NotificationCompat;
import androidx.core.app.ServiceCompat;

// Mantém a call e/ou o vídeo do "Assistir junto" vivos com a tela desligada ou o app em segundo plano.
// Mostra uma notificação fixa (igual o Discord / YouTube).
public class ChamadaService extends Service {

    private static final String CANAL = "chamada";
    private PowerManager.WakeLock wake;
    private WifiManager.WifiLock wifi;

    @Override
    public IBinder onBind(Intent intent) { return null; }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        boolean call = MainActivity.emChamada;
        boolean video = MainActivity.assistindo;
        if (!call && !video) { stopSelf(); return START_NOT_STICKY; }

        String titulo;
        String texto;
        String video_t = MainActivity.tituloVideo == null || MainActivity.tituloVideo.isEmpty() ? "vídeo" : MainActivity.tituloVideo;
        if (call && video) { titulo = "Salinha — em call"; texto = "📺 Assistindo: " + video_t; }
        else if (call) { titulo = "Salinha — em call"; texto = "Toque pra voltar pra call"; }
        else { titulo = "Salinha — assistindo junto"; texto = "📺 " + video_t; }

        if (Build.VERSION.SDK_INT >= 26) {
            NotificationManager nm = getSystemService(NotificationManager.class);
            NotificationChannel canal = new NotificationChannel(CANAL, "Call e vídeo em andamento", NotificationManager.IMPORTANCE_LOW);
            canal.setDescription("Aparece enquanto você está numa call ou assistindo junto na Salinha");
            nm.createNotificationChannel(canal);
        }

        Intent abrir = new Intent(this, MainActivity.class);
        abrir.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent pi = PendingIntent.getActivity(this, 0, abrir,
                PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);

        Notification n = new NotificationCompat.Builder(this, CANAL)
                .setContentTitle(titulo)
                .setContentText(texto)
                .setSmallIcon(call ? android.R.drawable.ic_btn_speak_now : android.R.drawable.ic_media_play)
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .setContentIntent(pi)
                .setCategory(call ? NotificationCompat.CATEGORY_CALL : NotificationCompat.CATEGORY_TRANSPORT)
                .setPriority(NotificationCompat.PRIORITY_LOW)
                .build();

        int tipo = 0;
        if (call && Build.VERSION.SDK_INT >= 30) tipo |= ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE;
        if (video && Build.VERSION.SDK_INT >= 29) tipo |= ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK;
        try {
            ServiceCompat.startForeground(this, 1, n, tipo);
        } catch (Exception e) {
            // Ex.: microfone sem permissão -> tenta só com o vídeo
            try {
                ServiceCompat.startForeground(this, 1, n, video && Build.VERSION.SDK_INT >= 29 ? ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK : 0);
            } catch (Exception e2) {
                stopSelf();
                return START_NOT_STICKY;
            }
        }

        // Não deixa o processador nem o Wi-Fi "dormirem"
        if (wake == null) {
            PowerManager pm = (PowerManager) getSystemService(POWER_SERVICE);
            wake = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "salinha:chamada");
            wake.acquire(6 * 60 * 60 * 1000L); // no máximo 6 horas
        }
        if (wifi == null) {
            WifiManager wm = (WifiManager) getApplicationContext().getSystemService(WIFI_SERVICE);
            if (wm != null) {
                wifi = wm.createWifiLock(WifiManager.WIFI_MODE_FULL_HIGH_PERF, "salinha:chamada");
                wifi.acquire();
            }
        }
        return START_NOT_STICKY;
    }

    @Override
    public void onDestroy() {
        if (wake != null && wake.isHeld()) wake.release();
        if (wifi != null && wifi.isHeld()) wifi.release();
        if (Build.VERSION.SDK_INT >= 24) stopForeground(STOP_FOREGROUND_REMOVE);
        else stopForeground(true);
        super.onDestroy();
    }
}
