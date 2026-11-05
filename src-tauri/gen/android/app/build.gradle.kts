import java.util.Properties
import java.io.FileInputStream
import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("rust")
    id("io.sentry.android.gradle") version "6.19.0"
}

val fossBuild = providers.environmentVariable("SABLE_FOSS").orNull == "1"
val buildFlavor = providers.environmentVariable("SABLE_BUILD_FLAVOR").orNull

sentry {
    org.set(System.getenv("SENTRY_ORG"))
    projectName.set(System.getenv("SENTRY_PROJECT"))
    authToken.set(System.getenv("SENTRY_AUTH_TOKEN"))
    autoUploadProguardMapping.set(!System.getenv("SENTRY_AUTH_TOKEN").isNullOrBlank())
    includeProguardMapping.set(!fossBuild)
    tracingInstrumentation { enabled.set(false) }
    autoInstallation { enabled.set(false) }
    telemetry.set(false)
    ignoredBuildTypes.set(setOf("debug"))
}

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
    namespace = "moe.sable.client"
    defaultConfig {
        manifestPlaceholders["usesCleartextTraffic"] = "false"
        // Stable installs over Sable v1, which owns moe.sable.client.
        applicationId = if (buildFlavor == "nightly") "moe.sable.next.nightly" else "moe.sable.client"
        val appName = when (buildFlavor) {
            "stable" -> "Sable"
            "nightly" -> "Sable Nightly"
            else -> "sable-next"
        }
        resValue("string", "app_name", appName)
        resValue("string", "main_activity_title", appName)
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
            signingConfig = signingConfigs.getByName("release").takeIf { it.storeFile != null }
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
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
        // tauri-plugin-livekit-mobile requires it: LiveKit and WebRTC call
        // java.time APIs that only exist from API 26, and minSdk here is 24.
        isCoreLibraryDesugaringEnabled = true
    }
    buildFeatures {
        buildConfig = true
    }
    testOptions {
        unitTests.isIncludeAndroidResources = true
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

kotlin {
    compilerOptions {
        jvmTarget = JvmTarget.JVM_17
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
                tauriProperties.getProperty("tauri.android.versionCode", "1").toInt() + abiCode
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

// Include Tauri's generated plugin settings so packaging does not rerun Cargo.
tasks.register<org.gradle.api.tasks.bundling.Tar>("archiveNativeRelease") {
    val target = providers.gradleProperty("nativeTarget").getOrElse("aarch64")
    val abi = mapOf(
        "aarch64" to "arm64-v8a", "armv7" to "armeabi-v7a",
        "i686" to "x86", "x86_64" to "x86_64"
    )[target] ?: error("Unknown nativeTarget: $target")
    val nativeDir = file("src/main/jniLibs/$abi")

    archiveFileName.set("android-native-$target.tar.gz")
    destinationDirectory.set(rootProject.layout.buildDirectory.dir("native-artifacts"))
    compression = org.gradle.api.tasks.bundling.Compression.GZIP
    isPreserveFileTimestamps = false
    isReproducibleFileOrder = true
    from(nativeDir) { into("$target/jniLibs/$abi") }
    from(temporaryDir) { into(target) }
    if (target == "aarch64") {
        val checkout = rootProject.projectDir.resolve("../../..").canonicalFile
        val pluginPaths = rootProject.allprojects
            .filter { it != rootProject && it != project }
            .associate { dependency ->
                val source = dependency.projectDir.canonicalFile
                val path = if (source.toPath().startsWith(checkout.toPath())) {
                    rootProject.projectDir.toPath().relativize(source.toPath()).toString()
                } else ".ci-dependencies/${dependency.name}"
                dependency.projectDir to path
            }
        from("src/main") {
            into("$target/gradle/app/src/main")
            exclude("jniLibs/**")
        }
        // Packaging skips Cargo, which generates the JNI keep rules.
        from(files("tauri.build.gradle.kts", "tauri.properties", "proguard-tauri.pro")) {
            into("$target/gradle/app")
        }
        from(rootProject.file("tauri.settings.gradle")) {
            into("$target/gradle")
            filter { line: String ->
                val portable = pluginPaths.entries.fold(line) { text, (source, path) ->
                    text.replace(
                        "new File(\"$source\")",
                        "new File(settingsDir, '$path')"
                    )
                }
                check(!portable.contains("new File(\"")) { "Unrecognized Tauri settings: $portable" }
                portable
            }
        }
        pluginPaths.filterValues { it.startsWith(".ci-dependencies/") }
            .forEach { (source, path) ->
                from(source) {
                    into("$target/gradle/$path")
                    exclude("build/**", ".gradle/**", ".git/**", "local.properties", "keystore.properties")
                }
            }
    }
    val identity = listOf("BUILD_REVISION", "VERSION", "SABLE_BUILD_FLAVOR").map {
        providers.environmentVariable(it)
    }
    inputs.property("identity", identity.map { it.getOrElse("") })
    doFirst {
        check(nativeDir.resolve("libapp_lib.so").isFile) { "Missing native library for $target" }
        check(target != "aarch64" || file("proguard-tauri.pro").isFile) {
            "Missing generated Tauri JNI keep rules"
        }
        check(identity.all { it.isPresent && it.get().isNotBlank() }) { "Missing native build identity" }
        temporaryDir.resolve("identity").writeText((identity.map { it.get() } + target).joinToString("\n", postfix = "\n"))
    }
}

configurations.all {
    resolutionStrategy.dependencySubstitution {
        substitute(module("com.google.crypto.tink:tink"))
            .using(module("com.google.crypto.tink:tink-android:1.18.0"))
    }
}

dependencies {
    if (!fossBuild) {
        implementation("io.sentry:sentry-android:8.58.0")
        implementation("io.sentry:sentry-android-ndk:8.58.0")
    }
    implementation("androidx.webkit:webkit:1.14.0")
    implementation("androidx.appcompat:appcompat:1.7.1")
    implementation("androidx.activity:activity-ktx:1.10.1")
    implementation("androidx.browser:browser:1.8.0")
    implementation("com.google.android.material:material:1.12.0")
    implementation("androidx.lifecycle:lifecycle-process:2.10.0")
    coreLibraryDesugaring("com.android.tools:desugar_jdk_libs:2.1.5")
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.robolectric:robolectric:4.16.1")
    androidTestImplementation("androidx.test.ext:junit:1.1.4")
    androidTestImplementation("androidx.test.espresso:espresso-core:3.5.0")
}

apply(from = "tauri.build.gradle.kts")

val sortTauriConfig by tasks.registering {
    val config = file("src/main/assets/tauri.conf.json")
    doLast {
        if (!config.exists()) return@doLast
        fun sorted(value: Any?): Any? = when (value) {
            is Map<*, *> -> value.entries.sortedBy { it.key as String }.associate { it.key to sorted(it.value) }
            is List<*> -> value.map(::sorted)
            else -> value
        }
        config.writeText(groovy.json.JsonOutput.toJson(sorted(groovy.json.JsonSlurper().parse(config))))
    }
}
tasks.withType<org.jetbrains.kotlin.gradle.tasks.KotlinCompile>().configureEach {
    exclude(if (fossBuild) "**/google/NativeSentry.kt" else "**/foss/NativeSentry.kt")
}

tasks.matching { it.name.startsWith("merge") && it.name.endsWith("Assets") }.configureEach {
    dependsOn(sortTauriConfig)
}

// Native FCM push (Sygnal): applies only once google-services.json is added to this
// directory, so builds without Firebase configured still succeed.
// Skipped for FOSS builds: the plugin injects the Firebase project ids as string
// resources even when no Firebase library is linked.
if (!fossBuild && file("google-services.json").exists()) {
    apply(plugin = "com.google.gms.google-services")
}
