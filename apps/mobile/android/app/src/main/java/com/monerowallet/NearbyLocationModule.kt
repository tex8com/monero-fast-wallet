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
import android.util.Log
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
      Log.w(NAME, "Location permission is not granted")
      promise.reject("LOCATION_PERMISSION_DENIED", "Location permission is not granted")
      return
    }

    val manager = reactApplicationContext.getSystemService(Context.LOCATION_SERVICE) as LocationManager
    // Always ask Android for a current position. When the user selected
    // approximate location, Android itself obfuscates the result; skipping
    // GPS here prevented a real location request (and its privacy indicator)
    // from happening at all on some devices.
    val preferredProviders = listOf(
      LocationManager.GPS_PROVIDER,
      LocationManager.NETWORK_PROVIDER,
      LocationManager.PASSIVE_PROVIDER,
    )
    val providers = preferredProviders.filter { provider -> runCatching { manager.isProviderEnabled(provider) }.getOrDefault(false) }

    if (providers.isEmpty()) {
      Log.w(NAME, "No enabled location provider is available")
      promise.reject("LOCATION_UNAVAILABLE", "No location provider is available")
      return
    }

    val fallback = providers
      .mapNotNull { provider -> runCatching { manager.getLastKnownLocation(provider) }.getOrNull() }
      .maxByOrNull { location -> location.time }
    Log.i(NAME, "Location request started; providers=$providers precise=$hasFine fallback=${fallback != null}")
    val finished = AtomicBoolean(false)
    val handler = Handler(Looper.getMainLooper())
    val cancellations = mutableListOf<CancellationSignal>()
    val listeners = mutableListOf<Pair<String, LocationListener>>()
    val complete: (Location?) -> Unit = { location ->
      if (finished.compareAndSet(false, true)) {
        cancellations.forEach { cancellation -> cancellation.cancel() }
        listeners.forEach { (provider, listener) ->
          runCatching { manager.removeUpdates(listener) }
            .onFailure { error -> Log.d(NAME, "Could not remove $provider listener", error) }
        }
        if (location != null) {
          Log.i(NAME, "Location request completed; provider=${location.provider} accuracy=${location.accuracy}")
          promise.resolve(locationMap(location))
        } else {
          Log.w(NAME, "Location request completed without a location")
          promise.reject("LOCATION_UNAVAILABLE", "No location is currently available")
        }
      }
    }

    handler.postDelayed({ complete(fallback) }, 10_000)

    try {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
        providers.forEach { provider ->
          val cancellation = CancellationSignal()
          cancellations.add(cancellation)
          runCatching {
            manager.getCurrentLocation(
              provider,
              cancellation,
              ContextCompat.getMainExecutor(reactApplicationContext),
            ) { location ->
              if (location != null) {
                complete(location)
              } else {
                Log.d(NAME, "Provider $provider returned no current location")
              }
            }
          }.onFailure { error ->
            Log.w(NAME, "Provider $provider request failed", error)
          }
        }
        return
      }

      providers.forEach { provider ->
        val listener = object : LocationListener {
          override fun onLocationChanged(location: Location) = complete(location)
          override fun onProviderDisabled(provider: String) = Unit
          override fun onProviderEnabled(provider: String) = Unit
          @Deprecated("Deprecated by Android")
          override fun onStatusChanged(provider: String?, status: Int, extras: Bundle?) = Unit
        }
        listeners.add(provider to listener)
        runCatching {
          @Suppress("DEPRECATION")
          manager.requestSingleUpdate(provider, listener, Looper.getMainLooper())
        }.onFailure { error ->
          Log.w(NAME, "Provider $provider request failed", error)
        }
      }
    } catch (error: RuntimeException) {
      Log.e(NAME, "Location request failed", error)
      complete(fallback)
    }
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
