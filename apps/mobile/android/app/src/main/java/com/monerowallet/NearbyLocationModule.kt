package com.monerowallet

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.pm.PackageManager
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.os.Build
import android.os.Bundle
import android.os.CancellationSignal
import android.os.Handler
import android.os.Looper
import androidx.core.content.ContextCompat
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import java.util.concurrent.atomic.AtomicBoolean

class NearbyLocationModule(
  reactContext: ReactApplicationContext,
) : ReactContextBaseJavaModule(reactContext) {

  override fun getName(): String = NAME

  @SuppressLint("MissingPermission")
  @ReactMethod
  fun getCurrentLocation(promise: Promise) {
    val hasCoarse = ContextCompat.checkSelfPermission(
      reactApplicationContext,
      Manifest.permission.ACCESS_COARSE_LOCATION,
    ) == PackageManager.PERMISSION_GRANTED
    val hasFine = ContextCompat.checkSelfPermission(
      reactApplicationContext,
      Manifest.permission.ACCESS_FINE_LOCATION,
    ) == PackageManager.PERMISSION_GRANTED
    if (!hasCoarse && !hasFine) {
      promise.reject("LOCATION_PERMISSION_DENIED", "Location permission is not granted")
      return
    }

    val manager = reactApplicationContext.getSystemService(Context.LOCATION_SERVICE) as LocationManager
    // Prefer GPS when the user granted precise location. The JS layer turns
    // the result into a coarse area and discards the exact coordinates.
    val preferredProviders = if (hasFine) {
      listOf(
        LocationManager.GPS_PROVIDER,
        LocationManager.NETWORK_PROVIDER,
        LocationManager.PASSIVE_PROVIDER,
      )
    } else {
      listOf(
        LocationManager.NETWORK_PROVIDER,
        LocationManager.PASSIVE_PROVIDER,
      )
    }
    val providers = preferredProviders.filter { provider -> runCatching { manager.isProviderEnabled(provider) }.getOrDefault(false) }

    if (providers.isEmpty()) {
      promise.reject("LOCATION_UNAVAILABLE", "No location provider is available")
      return
    }

    val fallback = providers
      .mapNotNull { provider -> runCatching { manager.getLastKnownLocation(provider) }.getOrNull() }
      .maxByOrNull { location -> location.time }
    val provider = providers.first()
    val finished = AtomicBoolean(false)
    val handler = Handler(Looper.getMainLooper())
    val complete: (Location?) -> Unit = { location ->
      if (finished.compareAndSet(false, true)) {
        if (location != null) {
          promise.resolve(locationMap(location))
        } else {
          promise.reject("LOCATION_UNAVAILABLE", "No location is currently available")
        }
      }
    }

    handler.postDelayed({ complete(fallback) }, 10_000)

    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
      val cancellation = CancellationSignal()
      manager.getCurrentLocation(
        provider,
        cancellation,
        ContextCompat.getMainExecutor(reactApplicationContext),
      ) { location -> complete(location ?: fallback) }
      handler.postDelayed({ cancellation.cancel() }, 10_000)
      return
    }

    @Suppress("DEPRECATION")
    manager.requestSingleUpdate(
      provider,
      object : LocationListener {
        override fun onLocationChanged(location: Location) = complete(location)
        override fun onProviderDisabled(provider: String) = Unit
        override fun onProviderEnabled(provider: String) = Unit
        @Deprecated("Deprecated by Android")
        override fun onStatusChanged(provider: String?, status: Int, extras: Bundle?) = Unit
      },
      Looper.getMainLooper(),
    )
  }

  private fun locationMap(location: Location) = Arguments.createMap().apply {
    putDouble("latitude", location.latitude)
    putDouble("longitude", location.longitude)
    putDouble("accuracy", location.accuracy.toDouble())
    putDouble("timestamp", location.time.toDouble())
  }

  companion object {
    const val NAME = "NearbyLocation"
  }
}
