package it.eremite.busroma

import android.content.Context

/** Versione pubblica o beta. La beta la vede solo l'amministratore. */
object Canale {
    private fun prefs(ctx: Context) = ctx.getSharedPreferences("canale", Context.MODE_PRIVATE)
    fun beta(ctx: Context): Boolean = Accesso.isAdmin(ctx) && prefs(ctx).getBoolean("beta", false)
    fun setBeta(ctx: Context, on: Boolean) { prefs(ctx).edit().putBoolean("beta", on).apply() }
    fun url(ctx: Context): String = MainActivity.URL_MAPPA + (if (beta(ctx)) "beta/" else "")
}
