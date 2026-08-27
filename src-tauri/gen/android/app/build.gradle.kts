import java.util.Properties
import java.io.FileInputStream

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("rust")
}

val tauriProperties = Properties().apply {
    val propFile = file("tauri.properties")
    if (propFile.exists()) {
        propFile.inputStream().use { load(it) }
    }
}

android {
    compileSdk = 36
    namespace = "moe.sable.next"
    defaultConfig {
        manifestPlaceholders["usesCleartextTraffic"] = "false"
        applicationId = "moe.sable.next"
        minSdk = 24
        targetSdk = 36
        versionCode = tauriProperties.getProperty("tauri.android.versionCode", "1").toInt()
        versionName = tauriProperties.getProperty("tauri.android.versionName", "1.0")
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
            packaging {                jniLibs.keepDebugSymbols.add("*/arm64-v8a/*.so")
                jniLibs.keepDebugSymbols.add("*/armeabi-v7a/*.so")
                jniLibs.keepDebugSymbols.add("*/x86/*.so")
                jniLibs.keepDebugSymbols.add("*/x86_64/*.so")
            }
        }
        getByName("release") {
            signingConfig = signingConfigs.getByName("release")
            isMinifyEnabled = true
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
}

rust {
    // The repo root, not src-tauri: pnpm refuses to run in a directory with no
    // package.json of its own.
    rootDirRel = "../../../../"
}

// rustls-platform-verifier ships its Kotlin half as a Maven repository inside
// the crate, so the path has to be read back out of cargo metadata.
fun rustlsPlatformVerifierMaven(): String {
    val metadata = providers.exec {
        commandLine(
            "cargo", "metadata",
            "--format-version", "1",
            "--filter-platform", "aarch64-linux-android",
            "--manifest-path", File(rootDir, "../../Cargo.toml").canonicalPath,
        )
    }.standardOutput.asText.get()

    @Suppress("UNCHECKED_CAST")
    val packages = (groovy.json.JsonSlurper().parseText(metadata) as Map<String, Any>)
        .getValue("packages") as List<Map<String, Any>>
    val manifest = packages
        .first { it["name"] == "rustls-platform-verifier-android" }
        .getValue("manifest_path") as String

    return File(File(manifest).parentFile, "maven").path
}

repositories {
    maven {
        url = uri(rustlsPlatformVerifierMaven())
        metadataSources.artifact()
    }
}

configurations.all {
    resolutionStrategy.dependencySubstitution {
        substitute(module("com.google.crypto.tink:tink"))
            .using(module("com.google.crypto.tink:tink-android:1.18.0"))
    }
}

dependencies {
    implementation("rustls:rustls-platform-verifier:latest.release")
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