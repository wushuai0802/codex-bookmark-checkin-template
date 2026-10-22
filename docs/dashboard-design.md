# Dashboard surfaces and navigation

The dashboard offers off, standard and enhanced liquid-glass modes in Settings
under Appearance. Card coverage, refraction strength, transparency and elastic
feedback can be changed independently and persist in the current browser.
The visual and interaction study references [FlClash's UI update](https://github.com/chen08209/FlClash/commit/7c9627fffb35f2615fbfaa64b4b3a0c5834c52ed);
the browser implementation is independently authored and does not include its
Dart, capture pipeline or shaders.

## Card hierarchy

The workspace stylesheet owns the radius, spacing and glass tokens. Summary
cards use a 28px radius, content panels 24px, statistics 20px, inset groups 16px
and controls 12px. Phone panels reduce these values to preserve content width.
Calendar padding remains narrower on very small screens so day counters fit.

The overview adapts to the content container, including sidebar expansion:

- Wide layouts pair the summary with a two-by-two statistics grid. The
  action queue and runtime summary align beneath them.
- Intermediate layouts stack the summary above the statistics and use two
  queue columns when there is room.
- Phones use two statistics columns and single-column queue and task cards.

The result model and verification categories are independent of these surfaces.
An execution receipt does not become verified evidence through styling.

## Navigation and motion

Desktop navigation retains the collapsible sidebar. Phones provide overview,
tasks, calendar and a More button that opens the existing sidebar. All entries
share the existing route and history controller. A single background indicator
tracks the selected entry without moving its text.

The phone dock reserves bottom content space and respects the safe area. It is
hidden during text entry, sidebar transitions, authentication and open detail
dialogs. Selection menus remain bounded, scrollable and keyboard accessible;
their opening origin follows the trigger, and selection applies immediately.
Press feedback and short, cancellable animations respect reduced motion.

The optical layer uses a rounded-rectangle distance field encoded as a bounded
displacement texture. Standard mode refracts the actual backdrop; enhanced
mode separates RGB samples for edge dispersion. A bevel mask combines a clear
refractive rim with a hazier center. A separate sheen responds to press position
without moving text. Visible surfaces receive filters; detached and offscreen
surfaces release them, and geometry textures use a bounded cache.

SVG backdrop displacement is enabled on Chromium browsers with the relevant
CSS support. Other engines use a compatible blur and highlight surface, and
Settings identifies that mode. Without backdrop-filter, surfaces retain their
solid tint. The optical browser check compares real rendered pixels with
displacement enabled and zeroed; it also checks settings persistence, refresh
and filter cleanup. Viewport emulation does not establish physical-device
performance or identical rendering across engines.

Ordinary clicks and keyboard selection remain the menu interaction; optional
slide-to-pick gestures are outside this material update.
