package com.salinha.app;

import android.content.Intent;
import android.os.Build;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

// Usado pelo site: Capacitor.Plugins.Chamada.iniciar({ titulo, texto }) / .parar()
@CapacitorPlugin(name = "Chamada")
public class ChamadaPlugin extends Plugin {

    @PluginMethod
    public void iniciar(PluginCall call) {
        Intent i = new Intent(getContext(), ChamadaService.class);
        i.putExtra("titulo", call.getString("titulo", "Salinha"));
        i.putExtra("texto", call.getString("texto", "Você está em uma call"));
        try {
            if (Build.VERSION.SDK_INT >= 26) getContext().startForegroundService(i);
            else getContext().startService(i);
            MainActivity.emChamada = true;
            call.resolve();
        } catch (Exception e) {
            call.reject("Não consegui manter a call em segundo plano: " + e.getMessage());
        }
    }

    @PluginMethod
    public void parar(PluginCall call) {
        MainActivity.emChamada = false;
        getContext().stopService(new Intent(getContext(), ChamadaService.class));
        call.resolve();
    }
}
