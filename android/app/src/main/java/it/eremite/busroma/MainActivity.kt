package it.eremite.busroma

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import android.speech.tts.TextToSpeech
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.webkit.GeolocationPermissions
import android.webkit.JavascriptInterface
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import org.json.JSONArray
import java.util.Locale

/**
 * L'app è una "finestra" sulla mappa pubblicata su GitHub: così la mappa si aggiorna da sola,
 * mentre l'app aggiunge voce, vibrazione, schermo sempre acceso, benvenuto e aggiornamenti.
 */
class MainActivity : Activity() {

    companion object {
        const val URL_MAPPA = "https://eremite1.github.io/bus-roma-live/"
        private const val REQ_LOC = 1
        private const val REQ_FILE = 2
    }

    private lateinit var web: WebView
    private var tts: TextToSpeech? = null
    private var ttsReady = false
    private var pendingGeo: Pair<String, GeolocationPermissions.Callback>? = null
    private var fileCallback: ValueCallback<Array<Uri>>? = null
    private val main = Handler(Looper.getMainLooper())

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (!Accesso.autorizzato(this)) { mostraAccesso(); main.postDelayed({ Updater.check(this, quiet = true) }, 1500); return }
        val root = FrameLayout(this)

        web = WebView(this).apply {
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.databaseEnabled = true
            settings.setGeolocationEnabled(true)
            settings.mediaPlaybackRequiresUserGesture = false
            addJavascriptInterface(Ponte(), "Android")
            webViewClient = object : WebViewClient() {
                override fun shouldOverrideUrlLoading(view: WebView, req: WebResourceRequest): Boolean {
                    val u = req.url
                    // i link esterni (es. fonti dei dati) si aprono nel browser
                    if (u.host != null && !u.host!!.endsWith("github.io")) {
                        startActivity(Intent(Intent.ACTION_VIEW, u)); return true
                    }
                    return false
                }
            }
            webChromeClient = object : WebChromeClient() {
                override fun onGeolocationPermissionsShowPrompt(origin: String, callback: GeolocationPermissions.Callback) {
                    if (checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED) {
                        callback.invoke(origin, true, false)
                    } else {
                        pendingGeo = origin to callback
                        requestPermissions(arrayOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION), REQ_LOC)
                    }
                }
                override fun onShowFileChooser(view: WebView, cb: ValueCallback<Array<Uri>>, params: FileChooserParams): Boolean {
                    fileCallback?.onReceiveValue(null)
                    fileCallback = cb
                    return try { startActivityForResult(params.createIntent(), REQ_FILE); true } catch (e: Exception) { fileCallback = null; false }
                }
            }
        }
        if (savedInstanceState != null) web.restoreState(savedInstanceState) else web.loadUrl(URL_MAPPA)
        root.addView(web, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))

        // benvenuto a ogni apertura
        val splash = benvenuto()
        root.addView(splash, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        setContentView(root)

        val chiudi = Runnable {
            if (splash.parent != null) splash.animate().alpha(0f).setDuration(400).withEndAction { root.removeView(splash) }.start()
        }
        splash.setOnClickListener { main.removeCallbacks(chiudi); chiudi.run() }
        main.postDelayed(chiudi, 2800)

        tts = TextToSpeech(this) { status ->
            if (status == TextToSpeech.SUCCESS) { tts?.language = Locale.ITALIAN; ttsReady = true }
        }

        // all'apertura: c'è una versione nuova? (dopo il benvenuto)
        main.postDelayed({ Updater.check(this, quiet = true) }, 3200)
    }

    /** Schermata di accesso: si vede solo la prima volta, finché non si mette il codice giusto. */
    private fun mostraAccesso() {
        val dp = resources.displayMetrics.density
        val tel = Accesso.codiceTelefono(this)
        val col = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER_HORIZONTAL
            setPadding((28 * dp).toInt(), (60 * dp).toInt(), (28 * dp).toInt(), (28 * dp).toInt())
            background = GradientDrawable(GradientDrawable.Orientation.TOP_BOTTOM, intArrayOf(Color.parseColor("#A51C45"), Color.parseColor("#6E0F2B")))
        }
        fun testo(t: String, size: Float, c: String, bold: Boolean = false, top: Int = 0) = TextView(this).apply {
            text = t; textSize = size; setTextColor(Color.parseColor(c)); gravity = Gravity.CENTER
            if (bold) setTypeface(typeface, Typeface.BOLD)
            setPadding(0, (top * dp).toInt(), 0, 0)
        }
        col.addView(ImageView(this).apply { setImageResource(R.mipmap.ic_launcher) }, LinearLayout.LayoutParams((96 * dp).toInt(), (96 * dp).toInt()))
        col.addView(testo("Bus Roma Live", 26f, "#FFFFFF", true, 16))
        col.addView(testo("Per usare l'app serve un codice di accesso, valido solo per questo telefono. Si inserisce una volta sola.", 15f, "#F3E3E8", top = 12))
        col.addView(testo("Codice di questo telefono", 13f, "#E8C9D2", top = 22))
        col.addView(testo(tel, 30f, "#F2B33D", true, 2).apply { setTextIsSelectable(true) })
        col.addView(android.widget.Button(this).apply {
            text = "Invia il codice del telefono"
            setOnClickListener {
                startActivity(Intent.createChooser(Intent(Intent.ACTION_SEND).apply {
                    type = "text/plain"; putExtra(Intent.EXTRA_TEXT, "Codice telefono Bus Roma Live: $tel")
                }, "Invia il codice"))
            }
        })
        val campo = android.widget.EditText(this).apply {
            hint = "Codice di accesso (es. K8PD-2XQM)"
            setHintTextColor(Color.parseColor("#C9A3AF")); setTextColor(Color.WHITE); textSize = 20f
            gravity = Gravity.CENTER; isSingleLine = true
            inputType = android.text.InputType.TYPE_CLASS_TEXT or android.text.InputType.TYPE_TEXT_FLAG_CAP_CHARACTERS
        }
        col.addView(campo, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { topMargin = (24 * dp).toInt() })
        val esito = testo("", 14f, "#FFD7D7", top = 8)
        col.addView(android.widget.Button(this).apply {
            text = "Entra"
            setOnClickListener {
                if (Accesso.prova(this@MainActivity, campo.text.toString())) recreate()
                else esito.text = "Codice non valido per questo telefono."
            }
        }, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { topMargin = (12 * dp).toInt() })
        col.addView(esito)
        col.addView(testo("Manda il codice del telefono a chi gestisce l'app: ti risponderà con il codice di accesso.", 13f, "#E8C9D2", top = 18))
        setContentView(android.widget.ScrollView(this).apply { isFillViewport = true; addView(col) })
    }

    private fun benvenuto(): View {
        val dp = resources.displayMetrics.density
        val box = FrameLayout(this).apply {
            background = GradientDrawable(GradientDrawable.Orientation.TOP_BOTTOM,
                intArrayOf(Color.parseColor("#A51C45"), Color.parseColor("#6E0F2B")))
        }
        val col = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; gravity = Gravity.CENTER_HORIZONTAL }
        col.addView(ImageView(this).apply { setImageResource(R.mipmap.ic_launcher) },
            LinearLayout.LayoutParams((120 * dp).toInt(), (120 * dp).toInt()))
        col.addView(TextView(this).apply {
            text = "Benvenuti"
            textSize = 40f
            setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL))
            setTextColor(Color.WHITE)
            gravity = Gravity.CENTER
            setPadding(0, (24 * dp).toInt(), 0, 0)
        })
        col.addView(TextView(this).apply {
            text = "Bus Roma Live"
            textSize = 20f
            setTextColor(Color.parseColor("#F2B33D"))
            gravity = Gravity.CENTER
            setPadding(0, (6 * dp).toInt(), 0, 0)
        })
        col.addView(TextView(this).apply {
            text = "Mappa in tempo reale dei bus di Roma"
            textSize = 14f
            setTextColor(Color.parseColor("#E8D3DA"))
            gravity = Gravity.CENTER
            setPadding(0, (4 * dp).toInt(), 0, 0)
        })
        box.addView(col, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.CENTER))
        box.addView(TextView(this).apply {
            text = "versione ${Updater.currentName(this@MainActivity)} · dati aperti Roma Mobilità\nApp non ufficiale, non collegata ad ATAC"
            textSize = 12f
            setTextColor(Color.parseColor("#D9B8C3"))
            gravity = Gravity.CENTER
            setPadding(0, 0, 0, (36 * dp).toInt())
        }, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.BOTTOM))
        return box
    }

    /** Funzioni del telefono che la mappa può usare (window.Android in JavaScript). */
    inner class Ponte {
        @JavascriptInterface fun speak(text: String, interrupt: Boolean) {
            if (!ttsReady) return
            tts?.speak(text, if (interrupt) TextToSpeech.QUEUE_FLUSH else TextToSpeech.QUEUE_ADD, null, "bus${System.nanoTime()}")
        }
        @JavascriptInterface fun stopSpeak() { tts?.stop() }
        @JavascriptInterface fun vibrate(patternJson: String) {
            val arr = try { JSONArray(patternJson) } catch (e: Exception) { JSONArray().put(200) }
            // il formato web è [vibra, pausa, vibra…]; Android vuole [attesa, vibra, pausa…]
            val p = LongArray(arr.length() + 1)
            p[0] = 0
            for (i in 0 until arr.length()) p[i + 1] = arr.optLong(i, 0)
            val v: Vibrator = if (Build.VERSION.SDK_INT >= 31) (getSystemService(VibratorManager::class.java)).defaultVibrator
                else @Suppress("DEPRECATION") getSystemService(Vibrator::class.java)
            v.vibrate(VibrationEffect.createWaveform(p, -1))
        }
        @JavascriptInterface fun keepAwake(on: Boolean) {
            runOnUiThread {
                if (on) window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
                else window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
            }
        }
        @JavascriptInterface fun appVersion(): String = Updater.currentName(this@MainActivity)
        @JavascriptInterface fun isAdmin(): Boolean = Accesso.isAdmin(this@MainActivity)
        @JavascriptInterface fun genCode(tel: String): String = if (Accesso.isAdmin(this@MainActivity)) Accesso.codicePer(tel) else ""
        @JavascriptInterface fun phoneCode(): String = Accesso.codiceTelefono(this@MainActivity)
        @JavascriptInterface fun checkUpdate() { runOnUiThread { Updater.check(this@MainActivity, quiet = false) } }
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == REQ_LOC) {
            val ok = grantResults.any { it == PackageManager.PERMISSION_GRANTED }
            pendingGeo?.let { (origin, cb) -> cb.invoke(origin, ok, false) }
            pendingGeo = null
        }
    }

    @Deprecated("Activity semplice: va bene")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode == REQ_FILE) {
            fileCallback?.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(resultCode, data))
            fileCallback = null
        }
    }

    @Deprecated("Gestione del tasto indietro")
    override fun onBackPressed() {
        if (!::web.isInitialized) { @Suppress("DEPRECATION") super.onBackPressed(); return }
        // prima prova a chiudere il pannello aperto nella mappa, poi torna indietro, poi esce
        web.evaluateJavascript("(function(){var b=document.getElementById('sheetClose');var s=document.getElementById('sheet');if(s&&!s.hidden&&b){b.click();return 'chiuso';}return '';})()") { r ->
            if (r?.contains("chiuso") != true) {
                if (web.canGoBack()) web.goBack() else @Suppress("DEPRECATION") super.onBackPressed()
            }
        }
    }

    override fun onSaveInstanceState(outState: Bundle) { super.onSaveInstanceState(outState); if (::web.isInitialized) web.saveState(outState) }

    private var primoResume = true
    override fun onResume() {
        super.onResume()
        // aggiornamento obbligatorio: se l'utente è uscito dall'installazione, il messaggio ricompare
        if (!primoResume) Updater.check(this, quiet = true)
        primoResume = false
    }

    override fun onDestroy() { tts?.shutdown(); if (::web.isInitialized) web.destroy(); super.onDestroy() }
}
