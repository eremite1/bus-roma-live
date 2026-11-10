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

    private fun benvenuto(): View {
        val box = FrameLayout(this).apply { setBackgroundColor(Color.parseColor("#1B1D22")) }
        box.addView(ImageView(this).apply {
            setImageResource(R.drawable.benvenuto)
            scaleType = ImageView.ScaleType.CENTER_CROP
        }, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        val fascia = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER_HORIZONTAL
            setPadding(48, 64, 48, 120)
            background = GradientDrawable(GradientDrawable.Orientation.BOTTOM_TOP, intArrayOf(Color.parseColor("#E61B1D22"), Color.TRANSPARENT))
        }
        fascia.addView(TextView(this).apply {
            text = "Benvenuti!"
            textSize = 46f
            setTypeface(typeface, Typeface.BOLD)
            setTextColor(Color.WHITE)
            gravity = Gravity.CENTER
            setShadowLayer(12f, 0f, 3f, Color.BLACK)
        })
        fascia.addView(TextView(this).apply {
            text = "Bus Roma Live · versione ${Updater.currentName(this@MainActivity)}"
            textSize = 15f
            setTextColor(Color.parseColor("#F2B33D"))
            gravity = Gravity.CENTER
            setPadding(0, 12, 0, 0)
        })
        box.addView(fascia, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.BOTTOM))
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
        // prima prova a chiudere il pannello aperto nella mappa, poi torna indietro, poi esce
        web.evaluateJavascript("(function(){var b=document.getElementById('sheetClose');var s=document.getElementById('sheet');if(s&&!s.hidden&&b){b.click();return 'chiuso';}return '';})()") { r ->
            if (r?.contains("chiuso") != true) {
                if (web.canGoBack()) web.goBack() else @Suppress("DEPRECATION") super.onBackPressed()
            }
        }
    }

    override fun onSaveInstanceState(outState: Bundle) { super.onSaveInstanceState(outState); web.saveState(outState) }

    override fun onDestroy() { tts?.shutdown(); web.destroy(); super.onDestroy() }
}
