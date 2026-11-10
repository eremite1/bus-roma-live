plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// il numero di versione cresce da solo a ogni compilazione su GitHub
val buildNum = (System.getenv("GITHUB_RUN_NUMBER") ?: "1").toInt()

android {
    namespace = "it.eremite.busroma"
    compileSdk = 35
    defaultConfig {
        applicationId = "it.eremite.busroma"
        minSdk = 29
        targetSdk = 35
        versionCode = buildNum
        versionName = "1.0.$buildNum"
    }
    signingConfigs {
        create("fisso") {
            storeFile = file("busroma.keystore")
            storePassword = "busromalive"
            keyAlias = "busroma"
            keyPassword = "busromalive"
        }
    }
    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.getByName("fisso")
        }
        debug { signingConfig = signingConfigs.getByName("fisso") }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
    lint { checkReleaseBuilds = false; abortOnError = false }
}

dependencies {
    implementation("androidx.core:core-ktx:1.15.0")
}
