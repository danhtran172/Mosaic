# InDeck Extension

Chrome extension for saving web images into one fixed InDeck profile.

## Install

1. Install and launch the packaged InDeck desktop app once. It registers the
   per-user Chrome Native Messaging host automatically; administrator access is
   not required.
2. Open `chrome://extensions`, enable **Developer mode**, then choose **Load
   unpacked** and select this `extension` directory.
3. Open the extension's **Details** page and select **Extension options**.
4. Choose the destination profile and click **Lưu lựa chọn**.

The selection is kept in Chrome storage. Saving a web image launches the native
host on demand, so no InDeck window needs to be open.

## Use

- Drag an image upward onto **Copy image** to copy its pixels to the clipboard.
- Drag an image downward onto a save target, or right-click an image and choose
  **Save image to InDeck**.
- Gallery quick slots remain profile-specific. They are configured only after a
  destination profile has been selected in Extension options.

## Development note

Native Messaging is registered by the packaged desktop build because Chrome
launches an executable directly. While using `npm start`, keep InDeck open only
for UI development; use an installed build to test the no-window import path.
