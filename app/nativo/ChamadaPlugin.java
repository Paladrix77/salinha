package com.salinha.app;

import android.content.Intent;
import android.os.Build;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

// Usado pelo site:
//   Capacitor.Plugins.Chamada.iniciar() / .parar()          -> call em segundo plano
//   Capacitor.Plugins.Chamada.assistir({ ativo, titulo })    -> vídeo em segundo plano + telinha (PiP)
@CapacitorPlugin(name = "Chamada")
public class ChamadaPlugin extends Plugin {

    @PluginMethod
    public void iniciar(PluginCall call) {
        MainActivity.emChamada = true;
        atualizarServico(call);
    }

    @PluginMethod
    public void parar(PluginCall call) {
        MainActivity.emChamada = false;
        atualizarServico(call);
    }

    @PluginMethod
    public void assistir(PluginCall call) {
        MainActivity.assistindo = Boolean.TRUE.equals(call.getBoolean("ativo", false));
        MainActivity.tituloVideo = call.getString("titulo", "");
        if (getActivity() instanceof MainActivity) {
            MainActivity act = (MainActivity) getActivity();
            act.runOnUiThread(act::atualizarPip);
        }
        atualizarServico(call);
    }

    // Liga/atualiza o serviço se tem call ou vídeo rolando; desliga se não tem nada
    private void atualizarServico(PluginCall call) {
        Intent i = new Intent(getContext(), ChamadaService.class);
        try {
            if (MainActivity.emChamada || MainActivity.assistindo) {
                if (Build.VERSION.SDK_INT >= 26) getContext().startForegroundService(i);
                else getContext().startService(i);
            } else {
                getContext().stopService(i);
            }
            call.resolve();
        } catch (Exception e) {
            call.reject("Não consegui manter em segundo plano: " + e.getMessage());
        }
    }
}
