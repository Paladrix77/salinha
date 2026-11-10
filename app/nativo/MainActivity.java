package com.salinha.app;

import android.Manifest;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Bundle;
import android.webkit.WebView;

import androidx.activity.OnBackPressedCallback;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;

import com.getcapacitor.BridgeActivity;

import java.util.ArrayList;
import java.util.List;

public class MainActivity extends BridgeActivity {

    // Ligado enquanto a pessoa está numa call (o plugin Chamada controla)
    public static volatile boolean emChamada = false;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(ChamadaPlugin.class);
        super.onCreate(savedInstanceState);

        // Pede microfone, câmera e notificações logo na primeira abertura
        List<String> pedir = new ArrayList<>();
        for (String p : new String[]{Manifest.permission.RECORD_AUDIO, Manifest.permission.CAMERA}) {
            if (ContextCompat.checkSelfPermission(this, p) != PackageManager.PERMISSION_GRANTED) pedir.add(p);
        }
        if (Build.VERSION.SDK_INT >= 33
                && ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            pedir.add(Manifest.permission.POST_NOTIFICATIONS);
        }
        if (!pedir.isEmpty()) ActivityCompat.requestPermissions(this, pedir.toArray(new String[0]), 1);

        // Vídeos e áudio da call tocam sem precisar de toque na tela
        try {
            getBridge().getWebView().getSettings().setMediaPlaybackRequiresUserGesture(false);
        } catch (Exception ignored) { }

        // Botão "voltar" do Android: manda o app pro fundo em vez de fechar (não derruba a call)
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                WebView w = getBridge() != null ? getBridge().getWebView() : null;
                if (w != null && w.canGoBack()) w.goBack();
                else moveTaskToBack(true);
            }
        });
    }

    // Em call, não deixa o Android "congelar" o app quando sai da tela
    private void manterVivo() {
        if (!emChamada) return;
        try {
            WebView w = getBridge().getWebView();
            w.onResume();
            w.resumeTimers();
        } catch (Exception ignored) { }
    }

    @Override
    public void onPause() {
        super.onPause();
        manterVivo();
    }

    @Override
    public void onStop() {
        super.onStop();
        manterVivo();
    }
}
