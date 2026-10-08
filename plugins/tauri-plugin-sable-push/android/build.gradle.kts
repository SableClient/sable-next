import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    id("com.android.library")
    id("org.jetbrains.kotlin.android")
}

val fossBuild = providers.environmentVariable("SABLE_FOSS").orNull == "1"

android {
    namespace = "moe.sable.push"
    compileSdk = 36

    defaultConfig {
        minSdk = 24
        missingDimensionStrategy("push", if (fossBuild) "foss" else "gms")
    }

    buildTypes {
        release {
            isMinifyEnabled = false
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_1_8
        targetCompatibility = JavaVersion.VERSION_1_8
    }
    kotlin {
        compilerOptions {
            jvmTarget = JvmTarget.JVM_1_8
        }
    }
    testOptions {
        unitTests.isIncludeAndroidResources = true
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.17.0")
    implementation("androidx.work:work-runtime:2.11.2")
    implementation(project(":tauri-android"))
    implementation(project(":tauri-plugin-notifications"))
    testImplementation("junit:junit:4.13.2")
    testImplementation("io.mockk:mockk-android:1.14.11")
    testImplementation("io.mockk:mockk-agent:1.14.11")
    testImplementation("org.jetbrains.kotlin:kotlin-test:2.3.0")
    testImplementation("org.json:json:20260522")
    testImplementation("org.robolectric:robolectric:4.16.1")
}
