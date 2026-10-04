import java.util.Properties
import java.io.FileInputStream

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("rust")
    id("io.sentry.android.gradle") version "6.19.0"
}

sentry {
    org.set(System.getenv("SENTRY_ORG"))
    projectName.set(System.getenv("SENTRY_PROJECT"))
    authToken.set(System.getenv("SENTRY_AUTH_TOKEN"))
    autoUploadProguardMapping.set(!System.getenv("SENTRY_AUTH_TOKEN").isNullOrBlank())
    tracingInstrumentation { enabled.set(false) }
    autoInstallation { enabled.set(false) }
    telemetry.set(false)
    ignoredBuildTypes.set(setOf("debug"))
}

val fossBuild = providers.environmentVariable("SABLE_FOSS").orNull == "1"

val tauriProperties = Properties().apply {
    val propFile = file("tauri.properties")
    if (propFile.exists()) {
        propFile.inputStream().use { load(it) }
    }
}

fun sentryBuildConfigValue(name: String): String =
    System.getenv(name).orEmpty().replace("\\", "\\\\").replace("\"", "\\\"")

android {
    compileSdk = 36
    System.getenv("ANDROID_NDK_VERSION")?.let { ndkVersion = it }
    namespace = "moe.sable.next"
    defaultConfig {
        manifestPlaceholders["usesCleartextTraffic"] = "false"
        applicationId = "moe.sable.next"
        missingDimensionStrategy("push", if (fossBuild) "foss" else "gms")
        minSdk = 24
        targetSdk = 36
        versionCode = tauriProperties.getProperty("tauri.android.versionCode", "1").toInt()
        versionName = tauriProperties.getProperty("tauri.android.versionName", "1.0")
    }
    dependenciesInfo {
        includeInApk = false
        includeInBundle = false
    }
    signingConfigs {
        create("release") {
            val keystorePropertiesFile = rootProject.file("keystore.properties")
            if (keystorePropertiesFile.exists()) {
                val keystoreProperties = Properties()
                keystoreProperties.load(FileInputStream(keystorePropertiesFile))

                keyAlias = keystoreProperties["keyAlias"] as String
                keyPassword = keystoreProperties["password"] as String
                storeFile = file(keystoreProperties["storeFile"] as String)
                storePassword = keystoreProperties["password"] as String
            }
        }
    }
    buildTypes {
        getByName("debug") {
            applicationIdSuffix = ".debug"
            manifestPlaceholders["usesCleartextTraffic"] = "true"
            isDebuggable = true
            isJniDebuggable = true
            isMinifyEnabled = false
        }
        getByName("release") {
            signingConfig = signingConfigs.getByName("release")
            isMinifyEnabled = true
            packaging {
                jniLibs.useLegacyPackaging = true
            }
            proguardFiles(
                *fileTree(".") { include("**/*.pro") }
                    .plus(getDefaultProguardFile("proguard-android-optimize.txt"))
                    .toList().toTypedArray()
            )
        }
    }
    compileOptions {
        // tauri-plugin-livekit-mobile requires it: LiveKit and WebRTC call
        // java.time APIs that only exist from API 26, and minSdk here is 24.
        isCoreLibraryDesugaringEnabled = true
    }
    kotlinOptions {
        jvmTarget = "1.8"
    }
    buildFeatures {
        buildConfig = true
    }
    defaultConfig {
        buildConfigField("String", "SENTRY_DSN", "\"${sentryBuildConfigValue("VITE_SENTRY_DSN")}\"")
        buildConfigField(
            "String",
            "SENTRY_ENVIRONMENT",
            "\"${sentryBuildConfigValue("VITE_SENTRY_ENVIRONMENT")}\""
        )
        buildConfigField(
            "String",
            "SENTRY_RELEASE",
            "\"${sentryBuildConfigValue("VITE_APP_VERSION")}\""
        )
    }
}

androidComponents {
    onVariants { variant ->
        if (!fossBuild) return@onVariants
        val abiCode = when (variant.flavorName) {
            "arm" -> 1
            "arm64" -> 2
            "x86" -> 3
            "x86_64" -> 4
            else -> 0
        }
        variant.outputs.forEach { output ->
            output.versionCode.set(
                tauriProperties.getProperty("tauri.android.versionCode", "1").toInt() * 10 + abiCode
            )
        }
    }
    onVariants(selector().withBuildType("debug")) { variant ->
        variant.packaging.jniLibs.keepDebugSymbols.addAll(
            "*/arm64-v8a/*.so",
            "*/armeabi-v7a/*.so",
            "*/x86/*.so",
            "*/x86_64/*.so"
        )
    }
}

rust {
    // The repo root, not src-tauri: pnpm refuses to run in a directory with no
    // package.json of its own.
    rootDirRel = "../../../../"
}

configurations.all {
    resolutionStrategy.dependencySubstitution {
        substitute(module("com.google.crypto.tink:tink"))
            .using(module("com.google.crypto.tink:tink-android:1.18.0"))
    }
}

dependencies {
    implementation("io.sentry:sentry-android:8.58.0")
    implementation("io.sentry:sentry-android-ndk:8.58.0")
    implementation("androidx.webkit:webkit:1.14.0")
    implementation("androidx.appcompat:appcompat:1.7.1")
    implementation("androidx.activity:activity-ktx:1.10.1")
    implementation("com.google.android.material:material:1.12.0")
    implementation("androidx.lifecycle:lifecycle-process:2.10.0")
    coreLibraryDesugaring("com.android.tools:desugar_jdk_libs:2.1.5")
    testImplementation("junit:junit:4.13.2")
    androidTestImplementation("androidx.test.ext:junit:1.1.4")
    androidTestImplementation("androidx.test.espresso:espresso-core:3.5.0")
}

apply(from = "tauri.build.gradle.kts")

// Native FCM push (Sygnal): applies only once google-services.json is added to this
// directory, so builds without Firebase configured still succeed.
// Skipped for FOSS builds: the plugin injects the Firebase project ids as string
// resources even when no Firebase library is linked.
if (!fossBuild && file("google-services.json").exists()) {
    apply(plugin = "com.google.gms.google-services")
}
