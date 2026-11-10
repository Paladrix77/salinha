package com.salinha.app;

import android.Manifest;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.WebView;

import androidx.activity.OnBackPressedCallback;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;

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

        ajustarBarrasDoSistema();

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

    // O conteúdo fica entre a barra de notificações (em cima) e a de navegação (embaixo),
    // e sobe junto quando o teclado abre.
    private void ajustarBarrasDoSistema() {
        try {
            View decor = getWindow().getDecorView();
            decor.setBackgroundColor(0xFF16171B); // fundo escuro atrás das barras
            WindowInsetsControllerCompat ctrl = WindowCompat.getInsetsController(getWindow(), decor);
            ctrl.setAppearanceLightStatusBars(false);     // ícones brancos (fundo escuro)
            ctrl.setAppearanceLightNavigationBars(false);

            View web = getBridge().getWebView();
            ViewCompat.setOnApplyWindowInsetsListener(web, (v, insets) -> {
                Insets barras = insets.getInsets(WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout());
                Insets teclado = insets.getInsets(WindowInsetsCompat.Type.ime());
                ViewGroup.MarginLayoutParams lp = (ViewGroup.MarginLayoutParams) v.getLayoutParams();
                lp.topMargin = barras.top;
                lp.bottomMargin = Math.max(barras.bottom, teclado.bottom);
                lp.leftMargin = barras.left;
                lp.rightMargin = barras.right;
                v.setLayoutParams(lp);
                return WindowInsetsCompat.CONSUMED;
            });
            ViewCompat.requestApplyInsets(web);
        } catch (Exception ignored) { }
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
