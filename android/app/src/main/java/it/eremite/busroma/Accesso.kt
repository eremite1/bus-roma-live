package it.eremite.busroma

import android.annotation.SuppressLint
import android.content.Context
import android.provider.Settings
import java.security.MessageDigest
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

/**
 * Accesso con codice "usa e getta": ogni telefono ha un suo codice (es. 7F3A-91C2) e il codice di
 * accesso funziona SOLO su quel telefono. Si inserisce una volta sola e resta salvato.
 * Chi conosce la password amministratore entra e può generare i codici per gli altri telefoni.
 */
object Accesso {
    private const val PREF = "accesso"
    private const val SALE = "b2005541b898a2b8"
    private const val ADMIN_HASH = "38e30b87efc3f9f2be0bc605dbee86db7631f4777bf80f1b2d488cf7025a4d60"
    private const val SEGRETO = "498fe0c9ff37c93ec50328f7d778cd7d13b7ea2220f109cc"
    private const val ALFABETO = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"

    private fun sha256(s: String) = MessageDigest.getInstance("SHA-256").digest(s.toByteArray())
    private fun hex(b: ByteArray) = b.joinToString("") { "%02x".format(it) }
    private fun pulisci(s: String) = s.uppercase().filter { it.isLetterOrDigit() }
    private fun aTrattini(s: String) = s.chunked(4).joinToString("-")

    @SuppressLint("HardwareIds")
    fun codiceTelefono(ctx: Context): String {
        val id = Settings.Secure.getString(ctx.contentResolver, Settings.Secure.ANDROID_ID) ?: "sconosciuto"
        return aTrattini(hex(sha256("busroma:$id")).take(8).uppercase())
    }

    /** Codice di accesso valido solo per il telefono indicato. */
    fun codicePer(codiceTelefono: String): String {
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(SEGRETO.toByteArray(), "HmacSHA256"))
        val d = mac.doFinal(pulisci(codiceTelefono).toByteArray())
        return aTrattini((0 until 8).map { ALFABETO[(d[it].toInt() and 0xff) % ALFABETO.length] }.joinToString(""))
    }

    private fun hashAdmin(input: String) = hex(sha256(SALE + input.trim()))
    private fun eAdmin(input: String) = hashAdmin(input) == ADMIN_HASH

    fun prefs(ctx: Context) = ctx.getSharedPreferences(PREF, Context.MODE_PRIVATE)

    fun autorizzato(ctx: Context): Boolean {
        val salvato = prefs(ctx).getString("codice", null) ?: return false
        return salvato == codicePer(codiceTelefono(ctx)) || isAdmin(ctx)
    }

    fun isAdmin(ctx: Context): Boolean {
        val p = prefs(ctx)
        // chi era già amministratore con la vecchia password resta amministratore
        if (p.getString("admin2", null) == null && p.getString("admin", null) != null)
            p.edit().remove("admin").putString("admin2", ADMIN_HASH).apply()
        return p.getString("admin2", null) == ADMIN_HASH
    }

    const val WHATSAPP = "393299554129"

    /** true se il codice è giusto per questo telefono (o è la password amministratore). */
    fun prova(ctx: Context, input: String): Boolean {
        if (eAdmin(input)) {
            prefs(ctx).edit().remove("admin").putString("admin2", hashAdmin(input)).putString("codice", codicePer(codiceTelefono(ctx))).apply()
            return true
        }
        if (pulisci(input) == pulisci(codicePer(codiceTelefono(ctx)))) {
            prefs(ctx).edit().putString("codice", codicePer(codiceTelefono(ctx))).apply()
            return true
        }
        return false
    }
}
