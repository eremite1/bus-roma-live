package it.eremite.busroma

import android.app.Activity
import android.app.AlertDialog
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.Settings
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.TextView
import android.widget.Toast
import androidx.core.content.FileProvider
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL

/** Controlla su GitHub se c'è una versione nuova dell'app, la scarica e la installa. */
object Updater {
    private const val API = "https://api.github.com/repos/eremite1/bus-roma-live/releases/latest"

    data class Info(val code: Int, val name: String, val url: String, val notes: String)

    fun currentCode(ctx: Context): Int =
        ctx.packageManager.getPackageInfo(ctx.packageName, 0).longVersionCode.toInt()

    fun currentName(ctx: Context): String =
        ctx.packageManager.getPackageInfo(ctx.packageName, 0).versionName ?: "?"

    /** quiet = all'apertura: nessun messaggio se è tutto aggiornato o se manca la rete. */
    fun check(act: Activity, quiet: Boolean) {
        Thread {
            val info = try { fetch() } catch (e: Exception) {
                if (!quiet) act.runOnUiThread { Toast.makeText(act, "Impossibile controllare: ${e.message ?: "nessuna connessione"}", Toast.LENGTH_LONG).show() }
                return@Thread
            }
            act.runOnUiThread {
                if (act.isFinishing) return@runOnUiThread
                if (info != null && info.code > currentCode(act)) ask(act, info)
                else if (!quiet) Toast.makeText(act, "L'app è aggiornata (versione ${currentName(act)})", Toast.LENGTH_LONG).show()
            }
        }.start()
    }

    private fun fetch(): Info? {
        val c = URL(API).openConnection() as HttpURLConnection
        c.setRequestProperty("Accept", "application/vnd.github+json")
        c.setRequestProperty("User-Agent", "BusRomaLive")
        c.connectTimeout = 10_000; c.readTimeout = 15_000
        try {
            if (c.responseCode != 200) throw Exception("errore ${c.responseCode}")
            val j = JSONObject(c.inputStream.bufferedReader().readText())
            val code = j.optString("tag_name").removePrefix("v").toIntOrNull() ?: return null
            val assets = j.optJSONArray("assets") ?: return null
            var url: String? = null
            for (i in 0 until assets.length()) {
                val a = assets.getJSONObject(i)
                if (a.optString("name").endsWith(".apk")) { url = a.optString("browser_download_url"); break }
            }
            return Info(code, j.optString("name", "Versione $code"), url ?: return null, j.optString("body").trim())
        } finally { c.disconnect() }
    }

    private fun ask(act: Activity, info: Info) {
        AlertDialog.Builder(act)
            .setTitle("Aggiornamento disponibile")
            .setMessage("È disponibile ${info.name} (tu hai la ${currentName(act)}).\n\n" +
                (if (info.notes.isNotBlank()) "Novità:\n${info.notes}" else ""))
            .setPositiveButton("Aggiorna ora") { _, _ -> download(act, info) }
            .setNegativeButton("Più tardi", null)
            .show()
    }

    private fun download(act: Activity, info: Info) {
        val bar = ProgressBar(act, null, android.R.attr.progressBarStyleHorizontal).apply { max = 100 }
        val label = TextView(act).apply { text = "Scarico la nuova versione…"; setPadding(0, 0, 0, 24) }
        val box = LinearLayout(act).apply { orientation = LinearLayout.VERTICAL; setPadding(64, 40, 64, 16); addView(label); addView(bar) }
        val dlg = AlertDialog.Builder(act).setTitle("Aggiornamento").setView(box).setCancelable(false).show()
        Thread {
            try {
                val dir = File(act.cacheDir, "aggiornamenti").apply { mkdirs() }
                dir.listFiles()?.forEach { it.delete() }
                val out = File(dir, "BusRomaLive-${info.code}.apk")
                var u = URL(info.url)
                var c: HttpURLConnection
                var hops = 0
                while (true) {
                    c = u.openConnection() as HttpURLConnection
                    c.instanceFollowRedirects = false
                    c.setRequestProperty("User-Agent", "BusRomaLive")
                    c.connectTimeout = 15_000; c.readTimeout = 30_000
                    val rc = c.responseCode
                    if (rc in 300..399 && hops < 5) { u = URL(u, c.getHeaderField("Location")); c.disconnect(); hops++; continue }
                    if (rc != 200) throw Exception("errore download $rc")
                    break
                }
                val total = c.contentLengthLong
                c.inputStream.use { ins ->
                    out.outputStream().use { os ->
                        val buf = ByteArray(64 * 1024)
                        var done = 0L
                        while (true) {
                            val n = ins.read(buf); if (n < 0) break
                            os.write(buf, 0, n); done += n
                            if (total > 0) { val p = (done * 100 / total).toInt(); act.runOnUiThread { bar.progress = p } }
                        }
                    }
                }
                c.disconnect()
                act.runOnUiThread { dlg.dismiss(); install(act, out) }
            } catch (e: Exception) {
                act.runOnUiThread { dlg.dismiss(); Toast.makeText(act, "Download non riuscito: ${e.message}", Toast.LENGTH_LONG).show() }
            }
        }.start()
    }

    /** Apre l'installatore di Android. Se serve, chiede prima il permesso "installa app sconosciute". */
    private fun install(act: Activity, file: File) {
        if (!act.packageManager.canRequestPackageInstalls()) {
            Toast.makeText(act, "Consenti l'installazione per Bus Roma Live, poi torna indietro e premi di nuovo Aggiorna", Toast.LENGTH_LONG).show()
            act.startActivity(Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${act.packageName}")))
            return
        }
        val uri = FileProvider.getUriForFile(act, "${act.packageName}.files", file)
        act.startActivity(
            Intent(Intent.ACTION_VIEW).setDataAndType(uri, "application/vnd.android.package-archive")
                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
        )
    }
}
