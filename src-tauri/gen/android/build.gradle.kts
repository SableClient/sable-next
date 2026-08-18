buildscript {
    repositories {
        google()
        mavenCentral()
    }
    dependencies {
        classpath("com.android.tools.build:gradle:8.11.0")
        // Above the Tauri template's 1.9.25: the UnifiedPush connector the
        // notifications plugin pulls in ships Kotlin 2.1 metadata, and 2.1.21
        // still ICEs on MainActivity ("source must not be null").
        classpath("org.jetbrains.kotlin:kotlin-gradle-plugin:2.2.0")
    }
}

allprojects {
    repositories {
        google()
        mavenCentral()
    }
}

tasks.register("clean").configure {
    delete("build")
}

