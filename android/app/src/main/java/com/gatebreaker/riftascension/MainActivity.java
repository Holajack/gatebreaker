package com.gatebreaker.riftascension;

import android.os.Bundle;

import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;

import com.getcapacitor.BridgeActivity;

/**
 * A bare BridgeActivity leaves the status and navigation bars on screen and lets
 * Android inset the window away from the camera cutout, which on a tall device
 * costs a large strip of the display and letterboxes the game. A full-screen
 * action game wants every pixel, so this opts into drawing behind the system
 * bars and the cutout, then hides the bars outright.
 *
 * The web layer already declares viewport-fit=cover and pads the HUD with
 * env(safe-area-inset-*), so once the window extends under the cutout the
 * controls inset themselves around it rather than disappearing beneath it.
 */
public class MainActivity extends BridgeActivity {

  @Override
  public void onCreate(Bundle savedInstanceState) {
    super.onCreate(savedInstanceState);
    goImmersive();
  }

  /**
   * The bars come back on their own after a swipe, an IME, or a return from the
   * recents screen, so re-assert on every focus gain rather than only at start.
   */
  @Override
  public void onWindowFocusChanged(boolean hasFocus) {
    super.onWindowFocusChanged(hasFocus);
    if (hasFocus) goImmersive();
  }

  private void goImmersive() {
    // false = we lay out under the system bars ourselves; combined with the
    // theme's shortEdges cutout mode this is what reclaims the notch strip.
    WindowCompat.setDecorFitsSystemWindows(getWindow(), false);

    WindowInsetsControllerCompat controller =
        WindowCompat.getInsetsController(getWindow(), getWindow().getDecorView());
    controller.hide(WindowInsetsCompat.Type.systemBars());
    // Transient-by-swipe rather than by-touch: a game gets constant taps, and
    // BEHAVIOR_SHOW_BARS_BY_TOUCH would flash the bars on every attack.
    controller.setSystemBarsBehavior(
        WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
  }
}
