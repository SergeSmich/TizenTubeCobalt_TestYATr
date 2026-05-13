// Copyright 2017 The Cobalt Authors. All Rights Reserved.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

package dev.cobalt.coat;

import static android.content.Context.AUDIO_SERVICE;
import static android.media.AudioManager.GET_DEVICES_INPUTS;
import static dev.cobalt.util.Log.TAG;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.Service;
import android.app.PictureInPictureParams;
import android.content.Context;
import android.content.pm.PackageManager;
import android.content.res.AssetManager;
import android.hardware.input.InputManager;
import android.hardware.display.DisplayManager;
import android.media.AudioDeviceInfo;
import android.media.AudioManager;
import android.os.Build;
import android.provider.Settings;
import android.util.Rational;
import android.view.Display;
import android.view.Surface;
import android.view.InputDevice;
import android.view.accessibility.CaptioningManager;
import androidx.annotation.Nullable;
import dev.cobalt.media.AudioOutputManager;
import dev.cobalt.shell.StartupGuard;
import dev.cobalt.util.DisplayUtil;
import dev.cobalt.util.Holder;
import dev.cobalt.util.Log;
import java.lang.reflect.Method;
import java.util.ArrayList;
import java.util.Calendar;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;
import java.util.TimeZone;
import java.util.concurrent.ConcurrentHashMap;
import org.chromium.content_public.browser.WebContents;
import org.jni_zero.CalledByNative;
import org.jni_zero.JNINamespace;
import org.jni_zero.NativeMethods;

/** Implementation of the required JNI methods called by the Starboard C++ code. */
@JNINamespace("starboard")
// TODO(cobalt, b/383301493): we expect this class to be a singleton and should consider enforcing
// this property.
public class StarboardBridge {

  /** Interface to be implemented by the Android Application hosting the starboard app. */
  public interface HostApplication {
    void setStarboardBridge(StarboardBridge starboardBridge);

    StarboardBridge getStarboardBridge();
  }

  private CobaltSystemConfigChangeReceiver mSysConfigChangeReceiver;
  private CobaltTextToSpeechHelper mTtsHelper;
  // TODO(cobalt): Re-enable these classes or remove if unnecessary.
  private AudioOutputManager mAudioOutputManager;
  private CobaltMediaSession mCobaltMediaSession;
  private AudioPermissionRequester mAudioPermissionRequester;
  private ResourceOverlay mResourceOverlay;
  private AdvertisingId mAdvertisingId;
  private VolumeStateReceiver mVolumeStateReceiver;
  private PlatformError mPlatformError;
  private final Context mAppContext;
  private final Holder<Activity> mActivityHolder;
  private final Holder<Service> mServiceHolder;
  private final String[] mArgs;
  private final long mNativeApp;
  private final Runnable mStopRequester =
      new Runnable() {
        @Override
        public void run() {
          // When the platform locale setting is updated, the application needs
          // to exit or the Accept-Language request header configuration needs
          // to be updated. The Accept-Language header configuration is set on
          // application start.
          //
          // To match cobalt 25, we're exiting the application.
          // https://source.corp.google.com/piper///depot/google3/third_party/cobalt/app/android/coat/branch_25_lts/java/dev/cobalt/coat/StarboardBridge.java;l=96
          afterStopped();
        }
      };

  private volatile boolean mApplicationStopped;
  private volatile boolean mApplicationStarted;

  private long mAppStartTimestamp = 0;

  private final Map<String, CobaltService.Factory> mCobaltServiceFactories = new HashMap<>();
  private final Map<String, CobaltService> mCobaltServices = new ConcurrentHashMap<>();

  private static final String GOOGLE_PLAY_SERVICES_PACKAGE = "com.google.android.gms";
  private static final String AMATI_EXPERIENCE_FEATURE =
      "com.google.android.feature.AMATI_EXPERIENCE";
  private final boolean mIsAmatiDevice;
  private static final TimeZone DEFAULT_TIME_ZONE = TimeZone.getTimeZone("America/Los_Angeles");
  private final long mTimeNanosecondsPerMicrosecond = 1000;
  private static final String YTS_CERT_SCOPE_SYSTEM_PROPERTY = "ro.vendor.youtube.cert_scope";

  public StarboardBridge(
      Context appContext,
      Holder<Activity> activityHolder,
      Holder<Service> serviceHolder,
      ArtworkDownloader artworkDownloader,
      String[] args,
      String startDeepLink) {

    Log.i(TAG, "StarboardBridge init.");

    // Make sure the JNI stack is properly initialized first as there is a
    // race condition as soon as any of the following objects creates a new thread.
    StarboardBridgeJni.get().initJNI(this);

    mAppContext = appContext;
    mActivityHolder = activityHolder;
    mServiceHolder = serviceHolder;
    mArgs = args;
    mSysConfigChangeReceiver = new CobaltSystemConfigChangeReceiver(appContext, mStopRequester);
    mTtsHelper = new CobaltTextToSpeechHelper(appContext);
    mAudioOutputManager = new AudioOutputManager(appContext);
    mCobaltMediaSession = new CobaltMediaSession(appContext, activityHolder, artworkDownloader);
    mAudioPermissionRequester = new AudioPermissionRequester(appContext, activityHolder);
    mResourceOverlay = new ResourceOverlay(appContext);
    mAdvertisingId = new AdvertisingId(appContext);
    //mVolumeStateReceiver = new VolumeStateReceiver(appContext);
    mIsAmatiDevice = appContext.getPackageManager().hasSystemFeature(AMATI_EXPERIENCE_FEATURE);

    mNativeApp =
        StarboardBridgeJni.get()
            .startNativeStarboard(
                getAssetsFromContext(),
                getFilesAbsolutePath(),
                getCacheAbsolutePath(),
                getNativeLibraryDir());

    StarboardBridgeJni.get().handleDeepLink(startDeepLink, /* applicationStarted= */ false);
    StarboardBridgeJni.get().setAndroidBuildFingerprint(getBuildFingerprint());
    StarboardBridgeJni.get().setAndroidOSExperience(mIsAmatiDevice);
    StarboardBridgeJni.get().setAndroidPlayServicesVersion(getPlayServicesVersion());
    StarboardBridgeJni.get().setYoutubeCertificationScope(getSystemProperty(YTS_CERT_SCOPE_SYSTEM_PROPERTY));
  }

  @NativeMethods
  interface Natives {
    long currentMonotonicTime();

    long startNativeStarboard(
        AssetManager assetManager, String filesDir, String cacheDir, String nativeLibraryDir);

    boolean initJNI(StarboardBridge starboardBridge);

    void closeNativeStarboard(long app);

    void initializePlatformAudioSink();

    void handleDeepLink(String url, boolean applicationStarted);

    void setAndroidBuildFingerprint(String fingerprint);

    void setAndroidOSExperience(boolean isAmatiDevice);

    void setAndroidPlayServicesVersion(long version);

    void setYoutubeCertificationScope(String certScope);

    boolean isReleaseBuild();

    boolean isDevelopmentBuild();
  }

  protected void onActivityStart(Activity activity) {
    Log.i(TAG, "onActivityStart ran");
    mActivityHolder.set(activity);
    mSysConfigChangeReceiver.setForeground(true);
    beforeStartOrResume();
  }

  protected void onActivityStop(Activity activity) {
    Log.i(TAG, "onActivityStop ran");
    beforeSuspend();
    mCobaltMediaSession.onActivityStop();
    if (mActivityHolder.get() == activity) {
      mActivityHolder.set(null);
    }
    mSysConfigChangeReceiver.setForeground(false);
  }

  protected void onActivityDestroy(Activity activity) {
    if (mApplicationStopped) {
      // We can't restart the starboard app, so kill the process for a clean start next time.
      Log.i(TAG, "Activity destroyed after shutdown; killing app.");
      StarboardBridgeJni.get().closeNativeStarboard(mNativeApp);
      closeAllServices();
      mAdvertisingId.shutdown();
      System.exit(0);
    } else {
      Log.i(TAG, "Activity destroyed without shutdown; app suspended in background.");
    }
  }

  protected void onServiceStart(Service service) {
    mServiceHolder.set(service);
  }

  protected void onServiceDestroy(Service service) {
    if (mServiceHolder.get() == service) {
      mServiceHolder.set(null);
    }
  }

  protected void beforeStartOrResume() {
    Log.i(TAG, "Prepare to resume");
    // Bring our platform services to life before resuming so that they're ready to deal with
    // whatever the web app wants to do with them as part of its start/resume logic.
    for (CobaltService service : mCobaltServices.values()) {
      service.beforeStartOrResume();
    }
    mAdvertisingId.refresh();
  }

  protected void beforeSuspend() {
    try {
      Log.i(TAG, "Prepare to suspend");
      // We want the MediaSession to be deactivated immediately before suspending so that by the
      // time, the launcher is visible our "Now Playing" card is already gone. Then Cobalt and
      // the web app can take their time suspending after that.
      for (CobaltService service : mCobaltServices.values()) {
        service.beforeSuspend();
      }
    } catch (Throwable e) {
      Log.i(TAG, "Caught exception in beforeSuspend: " + e.getMessage());
    }
  }

  private void closeAllServices() {
    mTtsHelper.shutdown();
    for (CobaltService service : mCobaltServices.values()) {
      service.afterStopped();
    }
  }

  protected void afterStopped() {
    mApplicationStopped = true;
    closeAllServices();
    Activity activity = mActivityHolder.get();
    if (activity != null) {
      // Wait until the activity is destroyed to exit.
      Log.i(TAG, "Shutdown in foreground; finishing Activity and removing task.");
      activity.finishAndRemoveTask();
    } else {
      // We can't restart the starboard app, so kill the process for a clean start next time.
      Log.i(TAG, "Shutdown in background; killing app without removing task.");
      System.exit(0);
    }
  }

  @CalledByNative
  protected void applicationStarted() {
    mApplicationStarted = true;
  }

  @CalledByNative
  protected void applicationStopping() {
    mApplicationStarted = false;
    mApplicationStopped = true;
  }

  @CalledByNative
  public void requestSuspend() {
    Activity activity = mActivityHolder.get();
    if (activity != null) {
      activity.moveTaskToBack(false);
    }
  }

  /* Immediate shutdown, used at least by StandalonePlayerActivity. */
  public void requestStop(int errorLevel) {
    applicationStopping();
    Activity activity = mActivityHolder.get();
    if (activity != null) {
      activity.finishAndRemoveTask();
    }
  }

  public boolean onSearchRequested() {
    return false;
  }

  @CalledByNative
  void raisePlatformError(@PlatformError.ErrorType int errorType, long data, String url) {
    StartupGuard.getInstance().setStartupMilestone(37);
    mPlatformError = new PlatformError(mActivityHolder, errorType, data, url);
    mPlatformError.raise();
  }

  @CalledByNative
  public boolean isPlatformErrorShowing() {
    if (mPlatformError != null) {
      return mPlatformError.isShowing();
    }
    return false;
  }

  /** Returns true if the native code is compiled for release (i.e. 'gold' build). */
  public static boolean isReleaseBuild() {
    return StarboardBridgeJni.get().isReleaseBuild();
  }

  /** Returns true if the native code is compiled for development (i.e. 'devel' build). */
  public static boolean isDevelopmentBuild() {
    return StarboardBridgeJni.get().isDevelopmentBuild();
  }

  protected Holder<Activity> getActivityHolder() {
    return mActivityHolder;
  }

  @CalledByNative
  protected String[] getArgs() {
    if (mArgs == null) {
      throw new IllegalArgumentException("mArgs cannot be null");
    }
    return mArgs;
  }

  // Initialize the platform's AudioTrackAudioSink. This must be done after the browser client
  // loads in the feature list and field trials.
  public void initializePlatformAudioSink() {
    StarboardBridgeJni.get().initializePlatformAudioSink();
  }

  /** Sends an event to the web app to navigate to the given URL */
  public void handleDeepLink(String url) {
    StarboardBridgeJni.get().handleDeepLink(url, mApplicationStarted);
  }

  public AssetManager getAssetsFromContext() {
    return mAppContext.getAssets();
  }

  public String getNativeLibraryDir() {
    return mAppContext.getApplicationInfo().nativeLibraryDir;
  }

  /**
   * Returns the absolute path to the directory where application specific files should be written.
   * May be overridden for use cases that need to segregate storage.
   */
  protected String getFilesAbsolutePath() {
    return mAppContext.getFilesDir().getAbsolutePath();
  }

  /**
   * Returns the absolute path to the application specific cache directory on the filesystem. May be
   * overridden for use cases that need to segregate storage.
   */
  protected String getCacheAbsolutePath() {
    return mAppContext.getCacheDir().getAbsolutePath();
  }

  // TODO: (cobalt b/372559388) remove or migrate JNI?
  // Used in starboard/android/shared/speech_synthesis_speak.cc
  @CalledByNative
  CobaltTextToSpeechHelper getTextToSpeechHelper() {
    if (mTtsHelper == null) {
      throw new IllegalArgumentException("mTtsHelper cannot be null for native code");
    }
    return mTtsHelper;
  }

  /**
   * @return A new CaptionSettings object with the current system caption settings.
   */
  @CalledByNative
  CaptionSettings getCaptionSettings() {
    CaptioningManager cm =
        (CaptioningManager) mAppContext.getSystemService(Context.CAPTIONING_SERVICE);
    return new CaptionSettings(cm);
  }

  /** Java-layer implementation of SbSystemGetLocaleId. */
  @CalledByNative
  String systemGetLocaleId() {
    return Locale.getDefault().toLanguageTag();
  }

  @CalledByNative
  String getTimeZoneId() {
    Locale locale = Locale.getDefault();
    Calendar calendar = Calendar.getInstance(locale);
    TimeZone timeZone = DEFAULT_TIME_ZONE;
    if (calendar != null) {
      timeZone = calendar.getTimeZone();
    }
    return timeZone.getID();
  }

  @CalledByNative
  DisplayUtil.DisplayDpi getDisplayDpi() {
    return DisplayUtil.getDisplayDpi();
  }

  @CalledByNative
  Size getDisplaySize() {
    android.util.Size size = DisplayUtil.getSystemDisplaySize();
    return new Size(size.getWidth(), size.getHeight());
  }

  @CalledByNative
  public ResourceOverlay getResourceOverlay() {
    if (mResourceOverlay == null) {
      throw new IllegalArgumentException("mResourceOverlay cannot be null for native code");
    }
    return mResourceOverlay;
  }

  @Nullable
  private static String getSystemProperty(String name) {
    try {
      @SuppressLint("PrivateApi")
      Class<?> systemProperties = Class.forName("android.os.SystemProperties");
      Method getMethod = systemProperties.getMethod("get", String.class);
      return (String) getMethod.invoke(systemProperties, name);
    } catch (Exception e) {
      Log.e(TAG, "Failed to read system property " + name, e);
      return null;
    }
  }

  /**
   * Checks if there is no microphone connected to the system.
   *
   * @return true if no device is connected.
   */
  @SuppressWarnings("unused")
  @CalledByNative
  public boolean isMicrophoneDisconnected() {
    // A check specifically for microphones is not available before API 28, so it is assumed that a
    // connected input audio device is a microphone.
    AudioManager audioManager = (AudioManager) mAppContext.getSystemService(AUDIO_SERVICE);
    AudioDeviceInfo[] devices = audioManager.getDevices(GET_DEVICES_INPUTS);
    if (devices.length > 0) {
      return false;
    }

    // fallback to check for BT voice capable RCU
    InputManager inputManager = (InputManager) mAppContext.getSystemService(Context.INPUT_SERVICE);
    final int[] inputDeviceIds = inputManager.getInputDeviceIds();
    for (int inputDeviceId : inputDeviceIds) {
      final InputDevice inputDevice = inputManager.getInputDevice(inputDeviceId);
      final boolean hasMicrophone = inputDevice.hasMicrophone();
      if (hasMicrophone) {
        return false;
      }
    }
    return true;
  }

  /**
   * Checks if the microphone is muted.
   *
   * @return true if the microphone mute is on.
   */
  @SuppressWarnings("unused")
  @CalledByNative
  public boolean isMicrophoneMute() {
    AudioManager audioManager = (AudioManager) mAppContext.getSystemService(AUDIO_SERVICE);
    return audioManager.isMicrophoneMute();
  }

  /** Returns string for kSbSystemPropertyUserAgentAuxField */
  @CalledByNative
  protected String getUserAgentAuxField() {
    // Spoof the aux field
    return "com.google.android.youtube.tv/7.02.302";
  }

  // TODO: (cobalt b/372559388) remove or migrate JNI?
  // Used in starboard/android/shared/system_get_property.cc
  /** Returns string for kSbSystemPropertyAdvertisingId */
  @CalledByNative
  protected String getAdvertisingId() {
    return mAdvertisingId.getId();
  }

  // TODO: (cobalt b/372559388) remove or migrate JNI?
  // Used in starboard/android/shared/system_get_property.cc
  /** Returns boolean for kSbSystemPropertyLimitAdTracking */
  @CalledByNative
  protected boolean getLimitAdTracking() {
    return mAdvertisingId.isLimitAdTrackingEnabled();
  }

  @CalledByNative
  AudioOutputManager getAudioOutputManager() {
    if (mAudioOutputManager == null) {
      throw new IllegalArgumentException("mAudioOutputManager cannot be null for native code");
    }
    return mAudioOutputManager;
  }

  /** Returns Java layer implementation for AudioPermissionRequester */
  @SuppressWarnings("unused")
  @CalledByNative
  AudioPermissionRequester getAudioPermissionRequester() {
    return mAudioPermissionRequester;
  }

  void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
    mAudioPermissionRequester.onRequestPermissionsResult(requestCode, permissions, grantResults);
  }

  @SuppressWarnings("unused")
  @CalledByNative
  public void resetVideoSurface() {
    Activity activity = mActivityHolder.get();
    if (activity instanceof CobaltActivity) {
      ((CobaltActivity) activity).resetVideoSurface();
    }
  }

  @SuppressWarnings("unused")
  @CalledByNative
  public void setVideoSurfaceBounds(final int x, final int y, final int width, final int height) {
    Activity activity = mActivityHolder.get();
    if (activity instanceof CobaltActivity) {
      ((CobaltActivity) activity).setVideoSurfaceBounds(x, y, width, height);
    }
  }

  // TODO: (cobalt b/372559388) remove or migrate JNI?
  // Used in starboard/android/shared/media_capabilities_cache.cc
  /** Return supported hdr types. */
  @CalledByNative
  public int[] getSupportedHdrTypes() {
    Display defaultDisplay = DisplayUtil.getDefaultDisplay();
    if (defaultDisplay == null) {
      return null;
    }

    Display.HdrCapabilities hdrCapabilities = defaultDisplay.getHdrCapabilities();
    if (hdrCapabilities == null) {
      return null;
    }

    return hdrCapabilities.getSupportedHdrTypes();
  }

  public CobaltMediaSession cobaltMediaSession() {
    return mCobaltMediaSession;
  }

  public void registerCobaltService(CobaltService.Factory factory) {
    mCobaltServiceFactories.put(factory.getServiceName(), factory);
  }

  @CalledByNative
  public boolean hasCobaltService(String serviceName) {
    return mCobaltServiceFactories.get(serviceName) != null;
  }

  // Explicitly pass activity as parameter.
  // Avoid using mActivityHolder.get(), because onActivityStop() can set it to null.
  @CalledByNative
  public CobaltService openCobaltService(
      long nativeService, String serviceName) {
    if (mCobaltServices.get(serviceName) != null) {
      // Attempting to re-open an already open service fails.
      Log.e(TAG, String.format("Cannot open already open service %s", serviceName));
      return null;
    }
    final CobaltService.Factory factory = mCobaltServiceFactories.get(serviceName);
    if (factory == null) {
      Log.e(TAG, String.format("Cannot open unregistered service %s", serviceName));
      return null;
    }
    CobaltService service = factory.createCobaltService(nativeService);
    if (service != null) {
      service.receiveStarboardBridge(this);
      mCobaltServices.put(serviceName, service);
      Log.i(TAG, String.format("Opened platform service %s.", serviceName));
    }
    return service;
  }

  public CobaltService getOpenedCobaltService(String serviceName) {
    return mCobaltServices.get(serviceName);
  }

  @CalledByNative
  public void closeCobaltService(String serviceName) {
    CobaltService service = mCobaltServices.remove(serviceName);
    if (service != null) {
      service.onClose();
    }
    Log.i(TAG, String.format("Closed platform service %s.", serviceName));
  }

  @CalledByNative
  public void closeAllCobaltService() {
    for (String serviceName : new ArrayList<>(mCobaltServices.keySet())) {
      closeCobaltService(serviceName);
    }
  }

  public byte[] sendToCobaltService(String serviceName, byte[] data) {
    CobaltService service = mCobaltServices.get(serviceName);
    if (service == null) {
      Log.e(TAG, String.format("Service not opened: %s", serviceName));
      return null;
    }
    CobaltService.ResponseToClient response = service.receiveFromClient(data);
    if (response.invalidState) {
      Log.e(TAG, String.format("Service %s received invalid data, closing.", serviceName));
      closeCobaltService(serviceName);
      return null;
    }
    return response.data;
  }

  /** Returns the application start timestamp. */
  protected void measureAppStartTimestamp() {
    if (mAppStartTimestamp != 0) {
      return;
    }
    Activity activity = mActivityHolder.get();
    if (!(activity instanceof CobaltActivity)) {
      return;
    }
    long javaStartTimestamp = ((CobaltActivity) activity).getAppStartTimestamp();
    long javaStopTimestamp = System.nanoTime();
    long appStartDuration = (javaStopTimestamp - javaStartTimestamp) / mTimeNanosecondsPerMicrosecond;

    long cppTimestamp = StarboardBridgeJni.get().currentMonotonicTime();
    mAppStartTimestamp = cppTimestamp - appStartDuration;
  }

  // Returns the saved app start timestamp.
  @CalledByNative
  protected long getAppStartTimestamp() {
    return mAppStartTimestamp;
  }

  @CalledByNative
  void reportFullyDrawn() {
    Activity activity = mActivityHolder.get();
    if (activity != null) {
      activity.reportFullyDrawn();
    }
  }

  @CalledByNative
  public void setCrashContext(String key, String value) {
    CrashContext.INSTANCE.setCrashContext(key, value);
  }

  public HashMap<String, String> getCrashContext() {
    return CrashContext.INSTANCE.getCrashContext();
  }

  public void registerCrashContextUpdateHandler(CrashContextUpdateHandler handler) {
    CrashContext.INSTANCE.registerCrashContextUpdateHandler(handler);
  }

  @CalledByNative
  protected boolean getIsAmatiDevice() {
    return mIsAmatiDevice;
  }

  @CalledByNative
  protected String getBuildFingerprint() {
    return Build.FINGERPRINT;
  }

  @CalledByNative
  protected long getPlayServicesVersion() {
    try {
      if (android.os.Build.VERSION.SDK_INT < 28) {
        return mAppContext
            .getPackageManager()
            .getPackageInfo(GOOGLE_PLAY_SERVICES_PACKAGE, 0)
            .versionCode;
      } else if (android.os.Build.VERSION.SDK_INT < 33) {
        return mAppContext
            .getPackageManager()
            .getPackageInfo(GOOGLE_PLAY_SERVICES_PACKAGE, 0)
            .getLongVersionCode();
      } else {
        return mAppContext
            .getPackageManager()
            .getPackageInfo(GOOGLE_PLAY_SERVICES_PACKAGE, PackageManager.PackageInfoFlags.of(0))
            .getLongVersionCode();
      }
    } catch (Exception e) {
      Log.w(TAG, "Unable to query Google Play Services package version", e);
      return 0;
    }
  }

  public void setWebContents(WebContents webContents) {
    mCobaltMediaSession.setWebContents(webContents);
    //mVolumeStateReceiver.setWebContents(webContents);
  }

  @CalledByNative
  public void closeApp() {
    Activity activity = mActivityHolder.get();
    if (activity instanceof CobaltActivity) {
      ((CobaltActivity) activity).finishAffinity();
    }
  }

  @CalledByNative
  protected boolean installAppFromURL(String url) {
    java.util.concurrent.ExecutorService executor = java.util.concurrent.Executors.newSingleThreadExecutor();
    android.os.Handler mainHandler = new android.os.Handler(android.os.Looper.getMainLooper());
    executor.execute(() -> {
      java.io.File apkFile = new java.io.File(mAppContext.getFilesDir(), "downloaded_app.apk");
      boolean success = false;
      try (java.io.InputStream in = new java.net.URL(url).openStream();
           java.io.OutputStream out = new java.io.FileOutputStream(apkFile)) {
        byte[] buffer = new byte[8192];
        int len;
        long total = 0;
        while ((len = in.read(buffer)) != -1) {
          out.write(buffer, 0, len);
          total += len;
        }
        out.flush();
        success = true;
      } catch (Exception e) {
      }
      if (success) {
        mainHandler.post(() -> {
          try {
            android.net.Uri contentUri = androidx.core.content.FileProvider.getUriForFile(
                mAppContext,
                mAppContext.getPackageName() + ".fileprovider",
                apkFile);
            android.content.Intent installIntent = new android.content.Intent(android.content.Intent.ACTION_VIEW);
            installIntent.setDataAndType(contentUri, "application/vnd.android.package-archive");
            installIntent.setFlags(android.content.Intent.FLAG_GRANT_READ_URI_PERMISSION | android.content.Intent.FLAG_ACTIVITY_NEW_TASK);
            Activity activity = mActivityHolder.get();
            if (activity != null) {
              activity.startActivity(installIntent);
            } else {
              mAppContext.startActivity(installIntent);
            }
          } catch (Exception e) {
          }
        });
      } else {
      }
      executor.shutdown();
    });
    return true;
  }

  @CalledByNative
  protected String getVersion() {
    try {
      android.content.pm.PackageInfo packageInfo =
          mAppContext.getPackageManager().getPackageInfo(mAppContext.getPackageName(), 0);
      return packageInfo.versionName;
    } catch (android.content.pm.PackageManager.NameNotFoundException e) {
      Log.e(TAG, "Failed to get package info", e);
      return "unknown";
    }
  }

  @CalledByNative
  protected String getBrandAndModel() {
    return Settings.Global.getString(mAppContext.getContentResolver(), "device_name");
  }

  @CalledByNative
  protected String getArchitecture() {
    return Build.SUPPORTED_ABIS[0];
  }

  @CalledByNative
  protected void setFrameRate(float frameRate) {
    if (Build.VERSION.SDK_INT < 30) {
      return;
    }

    Activity activity = mActivityHolder.get();
    if (activity == null) {
      return;
    }

    Display defaultDisplay = activity.getWindowManager().getDefaultDisplay();
    DisplayManager displayManager =
        (DisplayManager) mAppContext.getSystemService(Context.DISPLAY_SERVICE);

    boolean canBeSeamless = false;
    int strategy = 1;
    if (Build.VERSION.SDK_INT >= 31) {
        float[] supportedRefreshRates = defaultDisplay.getMode().getAlternativeRefreshRates();
        for (float rate : supportedRefreshRates) {
          if (Math.abs(rate - frameRate) < 0.1f || isMultiple(rate, frameRate, 0.1f)) {
            canBeSeamless = true;
            break;
          }
        }

        int contentPreference = displayManager.getMatchContentFrameRateUserPreference();
        if (contentPreference == DisplayManager.MATCH_CONTENT_FRAMERATE_NEVER) return;
        else if (contentPreference == DisplayManager.MATCH_CONTENT_FRAMERATE_SEAMLESSS_ONLY) {
          if (canBeSeamless) {
            strategy = Surface.CHANGE_FRAME_RATE_ONLY_IF_SEAMLESS;
          }
        } else if (contentPreference == DisplayManager.MATCH_CONTENT_FRAMERATE_ALWAYS) {
          strategy = Surface.CHANGE_FRAME_RATE_ALWAYS;
        } else {
          strategy = Surface.CHANGE_FRAME_RATE_ALWAYS;
        }
      }

    if (activity instanceof CobaltActivity) {
      if (Build.VERSION.SDK_INT == 30) {
        ((CobaltActivity) activity).setFrameRate(frameRate, 0);
      } else if (Build.VERSION.SDK_INT >= 31) {
        ((CobaltActivity) activity).setFrameRate(frameRate, strategy);
      }
    }
  }

  @CalledByNative
  protected void enterPIP() {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      Activity activity = mActivityHolder.get();
      if (activity.getPackageManager().hasSystemFeature(PackageManager.FEATURE_PICTURE_IN_PICTURE)) {
        Rational aspectRatio = new Rational(1920, 1080);
            PictureInPictureParams params = new PictureInPictureParams.Builder()
                    .setAspectRatio(aspectRatio)
                    .build();
            Boolean result = activity.enterPictureInPictureMode(params);
      }
    }
  }

  @CalledByNative
  protected boolean hasSystemFeature(String featureName) {
    return mAppContext.getPackageManager().hasSystemFeature(featureName);
  }

  private static boolean isMultiple(float refreshRate, float fps, float tolerance) {
    float ratio = refreshRate / fps;
    float nearestInt = Math.round(ratio);
    return Math.abs(ratio - nearestInt) < (tolerance / fps);
  }

  /** A wrapper of the android.util.Size class to be used by JNI. */
  public static class Size {
    private final int mWidth;
    private final int mHeight;

    public Size(int width, int height) {
      mWidth = width;
      mHeight = height;
    }

    @CalledByNative("Size")
    public int getWidth() {
      return mWidth;
    }

    @CalledByNative("Size")
    public int getHeight() {
      return mHeight;
    }
  }

  @CalledByNative
  protected void hideSplashScreen() {
    StartupGuard.getInstance().disarm();
  }

  @CalledByNative
  protected void setStartupMilestone(int milestone) {
    StartupGuard.getInstance().setStartupMilestone(milestone);
  }

  @CalledByNative
  protected void setStartupDiagnosisInfo(String key, String value) {
    StartupGuard.getInstance().setDiagnosisInfo(key, value);
  }
}
