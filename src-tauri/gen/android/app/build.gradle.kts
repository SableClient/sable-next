import org.jetbrains.kotlin.gradle.dsl.JvmTarget
import java.io.FileInputStream
import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("rust")
    id("io.sentry.android.gradle") version "6.26.0"
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
    namespace = "moe.sable.client"
    compileSdk = 37
    System.getenv("ANDROID_NDK_VERSION")?.let { ndkVersion = it }

    defaultConfig {
        minSdk = 24
        targetSdk = 37
        versionCode = tauriProperties.getProperty("tauri.android.versionCode", "1").toInt()
        versionName = tauriProperties.getProperty("tauri.android.versionName", "1.0")

        manifestPlaceholders["usesCleartextTraffic"] = "false"
        // Stable installs over Sable v1, which owns moe.sable.client.
        applicationId =
            if (buildFlavor == "nightly") "moe.sable.next.nightly" else "moe.sable.client"

        val appName = when (buildFlavor) {
            "stable" -> "Sable"
            "nightly" -> "Sable Nightly"
            else -> "sable-next"
        }

        resValue("string", "app_name", appName)
        resValue("string", "main_activity_title", appName)
        missingDimensionStrategy("push", if (fossBuild) "foss" else "gms")
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
            isShrinkResources = true
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
        resValues = true
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
tasks.register<Tar>("archiveNativeRelease") {
    val target = providers.gradleProperty("nativeTarget").getOrElse("aarch64")
    val abi = mapOf(
        "aarch64" to "arm64-v8a", "armv7" to "armeabi-v7a",
        "i686" to "x86", "x86_64" to "x86_64"
    )[target] ?: error("Unknown nativeTarget: $target")
    val nativeDir = file("src/main/jniLibs/$abi")

    description = "Include Tauri's generated plugin settings so packaging does not rerun Cargo"
    archiveFileName.set("android-native-$target.tar.gz")
    destinationDirectory.set(rootProject.layout.buildDirectory.dir("native-artifacts"))
    compression = Compression.GZIP
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
                    exclude(
                        "build/**",
                        ".gradle/**",
                        ".git/**",
                        "local.properties",
                        "keystore.properties"
                    )
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
        check(identity.all {
            it.isPresent && it.get().isNotBlank()
        }) { "Missing native build identity" }
        temporaryDir.resolve("identity")
            .writeText((identity.map { it.get() } + target).joinToString("\n", postfix = "\n"))
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
        implementation(libs.sentry.android)
        implementation(libs.sentry.android.ndk)
    }

    implementation(libs.androidx.webkit)
    implementation(libs.androidx.appcompat)
    implementation(libs.androidx.activity.ktx)
    implementation(libs.androidx.browser)
    implementation(libs.material)
    implementation(libs.androidx.lifecycle.process)
    coreLibraryDesugaring(libs.desugar.jdk.libs)
    testImplementation(libs.junit)
    testImplementation(libs.robolectric)
    androidTestImplementation(libs.androidx.junit)
    androidTestImplementation(libs.androidx.espresso.core)
}

apply(from = "tauri.build.gradle.kts")

val sortTauriConfig = tasks.register("sortTauriConfig") {
    description = "Sort Tauri configuration"

    val config = file("src/main/assets/tauri.conf.json")

    doLast {
        if (!config.exists()) return@doLast
        fun sorted(value: Any?): Any? = when (value) {
            is Map<*, *> -> value.entries.sortedBy { it.key as String }
                .associate { it.key to sorted(it.value) }

            is List<*> -> value.map(::sorted)
            else -> value
        }

        config.writeText(
            groovy.json.JsonOutput.toJson(
                sorted(
                    groovy.json.JsonSlurper().parse(config)
                )
            )
        )
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