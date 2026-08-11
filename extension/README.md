# Mosaic Extension

Chrome extension for saving web images into a selected Mosaic profile.

## Installation

1. Launch Mosaic or MosaicTest once. It registers a per-user Native Messaging host automatically.
2. Open `chrome://extensions`, enable **Developer mode**, then select **Load unpacked** and choose this `extension` folder.
3. Open **Extension options**, choose an available destination profile, then select **Save selection**.

The extension tries the production Mosaic host first and automatically falls back to MosaicTest when needed. The Native Messaging host starts on demand, so Mosaic does not need to remain open.

Profiles without an available Default Library Location remain visible but cannot be selected. If Mosaic is temporarily unavailable, the options page shows cached profiles in a disabled state.

## Use

- Drag an image upward onto **Copy image** to copy it to the clipboard.
- Drag an image downward to a save target, or right-click an image and choose **Save image to Mosaic**.
- Gallery quick slots are profile-specific and configured after choosing a destination profile.
