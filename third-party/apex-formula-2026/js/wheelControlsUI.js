import {
  H_PATTERN_ACTIONS,
  WHEEL_BUTTON_ACTIONS,
  calibratePedalAxis,
  calibrateSteeringAxis,
} from './controls.js';

export class WheelControlsView {
  constructor(manager, element, onBack) {
    this.manager = manager;
    this.element = element;
    this.onBack = onBack;
    this._frame = 0;
    this._capture = null;
    this._binding = null;
    this._bindingBaseline = new Set();
    this._everConnected = false;
    this._paintKey = null;
  }

  show(returnTo = 'main') {
    this.stop();
    this.returnTo = returnTo;
    this.manager.refresh();
    const config = this.manager.config;
    this.element.className = 'screen active menu-screen controls-screen';
    this.element.innerHTML = `
      <div class="menu-header"><div class="brand">APEX<em>FORMULA</em> 2026</div><div class="title">CONTROLS</div></div>
      <div class="menu-body"><div class="controls-layout">
        <section class="controls-panel device-panel">
          <header><h3>WHEEL STATUS</h3><span id="wheel-device-state">SCANNING</span></header>
          <div class="wheel-device-name" id="wheel-device-name">Wheel detected? Press any button on your wheel to activate it.</div>
          <p id="wheel-profile-note">Browser and OS axis order can differ. The detected profile is only a confidence-labelled seed; calibration is authoritative.</p>
        </section>

        <section class="controls-panel calibration-panel">
          <header><h3>CALIBRATION</h3><span id="pedal-layout">${config ? config.pedalLayout.toUpperCase() : 'NO DEVICE'}</span></header>
          <div class="capture-prompt" id="capture-prompt">Centre the wheel and release every pedal before starting.</div>
          <div class="capture-grid">
            ${this._captureButton('steering', 'CALIBRATE WHEEL')}
            ${this._captureButton('throttle', 'CALIBRATE THROTTLE')}
            ${this._captureButton('brake', 'CALIBRATE BRAKE')}
            ${this._captureButton('clutch', 'CALIBRATE CLUTCH')}
          </div>
          <div class="axis-assignments" id="axis-assignments"></div>
        </section>

        <section class="controls-panel tuning-panel">
          <header><h3>STEERING RANGE</h3><span id="car-lock-label">CAR LOCK ${this.manager.carLockToLock}°</span></header>
          <label class="control-setting"><span><b>Your wheel's lock-to-lock rotation</b><small>Set the wheel software to its maximum and enter that number. The game applies the car's ${this.manager.carLockToLock}° lock. Your wheel may keep turning past it; the car will not.</small></span>
            <input id="wheel-rotation" class="rotation-input" type="number" min="40" max="1440" step="10" value="${config?.rotation ?? 900}" aria-label="Wheel lock-to-lock rotation in degrees"></label>
          <label class="control-setting"><span><b>Steering quickness</b><small>The car's virtual lock-to-lock. 360° matches a real Formula rack; lower is quicker — full lock with less wheel. With a 900° wheel: 360° = full lock at 180° of rotation, 240° = at 120°.</small></span>
            <input id="wheel-car-lock" class="rotation-input" type="number" min="120" max="720" step="20" value="${config?.carLock ?? 360}" aria-label="Car virtual lock-to-lock in degrees"></label>
          <div class="control-setting"><span><b>Browser rumble</b><small id="rumble-note">Press any button on the wheel first; this control appears only when the browser reports a compatible actuator.</small></span>
            <div class="seg rumble-seg" id="rumble-buttons" hidden>${[
              [0, 'OFF'], [0.35, 'LOW'], [0.65, 'MED'], [1, 'FULL'],
            ].map(([value, label]) => `<button type="button" data-rumble="${value}">${label}</button>`).join('')}</div></div>
        </section>

        <section class="controls-panel bindings-panel">
          <header><h3>BUTTON BINDINGS</h3><span>PRESS TO REBIND</span></header>
          <div class="binding-grid" id="binding-grid">${this._bindingRows(WHEEL_BUTTON_ACTIONS)}</div>
          <details class="h-pattern"><summary>Optional H-pattern shifter</summary>
            <p>When the gearbox assist is set to manual, held shifter positions select gears 1–6. Sequential paddles continue to work.</p>
            <div class="binding-grid">${this._bindingRows(H_PATTERN_ACTIONS)}</div>
          </details>
        </section>

        <section class="controls-panel raw-panel">
          <header><h3>LIVE INPUTS</h3><span>GAMEPAD API</span></header>
          <div class="raw-heading">AXES</div><div class="raw-grid" id="raw-axes"></div>
          <div class="raw-heading">BUTTONS</div><div class="raw-grid buttons" id="raw-buttons"></div>
        </section>
      </div>
      <div class="btn-row controls-actions">
        <button class="f1-btn ghost" id="btn-back"><span>← BACK</span></button>
        <button class="f1-btn ghost danger" id="btn-wheel-reset"><span>RESET WHEEL PROFILE</span></button>
      </div></div>
      <div class="menu-footer"><span>Wheel calibration saves automatically in this browser</span><span>Keyboard controls remain available at all times</span></div>`;

    this._bindEvents();
    this._paintConfig();
    this._tick();
  }

  stop() {
    if (this._frame) cancelAnimationFrame(this._frame);
    this._frame = 0;
    this._capture = null;
    this._binding = null;
  }

  _captureButton(kind, label) {
    return `<button type="button" class="f1-btn ghost capture-btn" data-calibrate="${kind}"><span>${label}</span></button>`;
  }

  _bindingRows(actions) {
    return actions.map(action => `<div class="binding-row" data-binding-row="${action.key}">
      <span>${action.label}</span>
      <button type="button" class="binding-button" data-bind="${action.key}">UNBOUND</button>
      <button type="button" class="binding-clear" data-clear-bind="${action.key}" aria-label="Clear ${action.label} binding">×</button>
    </div>`).join('');
  }

  _bindEvents() {
    this.element.querySelector('#btn-back').addEventListener('click', () => this.onBack(this.returnTo));
    this.element.querySelector('#btn-wheel-reset').addEventListener('click', () => {
      if (!this.manager.device) return;
      this.manager.resetConfig();
      this._capture = null;
      this._binding = null;
      this._setPrompt('Wheel profile reset to the detected-device defaults.');
      this._paintConfig();
    });
    this.element.querySelectorAll('[data-calibrate]').forEach(button =>
      button.addEventListener('click', () => this._advanceCapture(button.dataset.calibrate)));
    this.element.querySelector('#wheel-car-lock').addEventListener('change', event => {
      const value = Number(event.target.value);
      this.manager.updateConfig(config => { config.carLock = value; return config; });
    });
    this.element.querySelector('#wheel-rotation').addEventListener('change', event => {
      const value = Math.max(40, Math.min(1440, Number(event.target.value) || 900));
      this.manager.updateConfig(config => { config.rotation = value; return config; });
      this._paintConfig();
    });
    this.element.querySelector('#rumble-buttons').addEventListener('click', event => {
      const button = event.target.closest('[data-rumble]');
      if (!button) return;
      this.manager.updateConfig(config => { config.rumbleStrength = +button.dataset.rumble; return config; });
      if (+button.dataset.rumble === 0) this.manager.stopRumble();
      this._paintConfig();
    });
    this.element.querySelectorAll('[data-bind]').forEach(button => button.addEventListener('click', () => {
      if (!this.manager.gamepad) { this._setPrompt('Connect the wheel before rebinding a button.'); return; }
      this._binding = button.dataset.bind;
      this._bindingBaseline = new Set(this.manager.gamepad.buttons
        .map((value, index) => value.pressed || value.value > 0.5 ? index : null).filter(index => index != null));
      this._setPrompt(`Press the wheel button for ${button.closest('.binding-row').querySelector('span').textContent}.`);
      this._paintConfig();
    }));
    this.element.querySelectorAll('[data-clear-bind]').forEach(button => button.addEventListener('click', () => {
      const action = button.dataset.clearBind;
      this.manager.updateConfig(config => { config.buttons[action] = null; return config; });
      this._paintConfig();
    }));
    this.element.querySelector('#axis-assignments').addEventListener('input', event => {
      const input = event.target.closest('[data-deadzone]');
      if (!input) return;
      const kind = input.dataset.deadzone;
      this.manager.updateConfig(config => { config.axes[kind].deadzone = +input.value; return config; });
      this._paintConfig();
    });
  }

  _axes() {
    this.manager.refresh();
    return this.manager.gamepad ? [...this.manager.gamepad.axes] : null;
  }

  _advanceCapture(kind) {
    const axes = this._axes();
    if (!axes) { this._setPrompt('Connect the wheel before starting calibration.'); return; }
    if (!this._capture || this._capture.kind !== kind) {
      this._capture = { kind, phase: 0, samples: {} };
      this._setPrompt(kind === 'steering'
        ? 'Centre the wheel, then click the wheel calibration button again.'
        : `Press and release the ${kind} once to wake its browser axis. Leave it fully released, then click again.`);
      return;
    }
    const capture = this._capture;
    if (kind === 'steering') {
      if (capture.phase === 0) {
        capture.samples.centre = axes; capture.phase = 1;
        this._setPrompt('Turn the wheel fully left and click the wheel calibration button.');
      } else if (capture.phase === 1) {
        capture.samples.left = axes; capture.phase = 2;
        this._setPrompt('Now turn the wheel fully right and click the wheel calibration button.');
      } else {
        capture.samples.right = axes;
        const calibration = calibrateSteeringAxis(capture.samples.centre, capture.samples.left, capture.samples.right,
          this.manager.config?.axes.steering.deadzone ?? 0.02);
        this._finishCalibration(kind, calibration);
      }
    } else if (capture.phase === 0) {
      capture.samples.rest = axes; capture.phase = 1;
      this._setPrompt(`Press the ${kind} fully and click its calibration button.`);
    } else {
      const calibration = calibratePedalAxis(capture.samples.rest, axes,
        this.manager.config?.axes[kind].deadzone ?? 0.04);
      this._finishCalibration(kind, calibration);
    }
  }

  _finishCalibration(kind, calibration) {
    if (!calibration) {
      this._capture = null;
      this._setPrompt(`No axis moved far enough for ${kind}. Try again while watching Live Inputs.`);
      return;
    }
    this.manager.updateConfig(config => {
      config.axes[kind] = calibration;
      return config;
    });
    this._capture = null;
    this._setPrompt(`${kind[0].toUpperCase() + kind.slice(1)} saved on axis ${calibration.axis}${calibration.inverted ? ' (inverted)' : ''}.`);
    this._paintConfig();
  }

  _setPrompt(message) {
    const prompt = this.element.querySelector('#capture-prompt');
    if (prompt) prompt.textContent = message;
  }

  _paintConfig() {
    const config = this.manager.config;
    if (!config) return;
    this.element.querySelector('#wheel-rotation').value = config.rotation;
    this.element.querySelector('#wheel-car-lock').value = config.carLock ?? 360;
    this.element.querySelectorAll('[data-rumble]').forEach(button =>
      button.classList.toggle('on', Math.abs(+button.dataset.rumble - config.rumbleStrength) < 0.01));
    this.element.querySelector('#pedal-layout').textContent = `${config.pedalLayout.toUpperCase()} PEDALS`;
    const capability = this.manager.rumbleCapability();
    const rumbleButtons = this.element.querySelector('#rumble-buttons');
    rumbleButtons.hidden = !capability.supported;
    this.element.querySelector('#rumble-note').textContent = capability.supported
      ? 'Kerbs, tyre slip and contact on devices whose browser exposes a compatible actuator.'
      : this.manager.gamepad
        ? 'Unavailable: this browser reports no compatible actuator. Logitech wheel force feedback is not exposed through the Gamepad API.'
        : 'Press any button on the wheel first; this control appears only when the browser reports a compatible actuator.';
    this.element.querySelector('#axis-assignments').innerHTML = ['steering', 'throttle', 'brake', 'clutch'].map(kind => {
      const item = config.axes[kind];
      const assignment = item.axis == null ? 'UNASSIGNED' : `AXIS ${item.axis}${item.inverted ? ' · INV' : ''}`;
      return `<label class="axis-assignment"><span><b>${kind.toUpperCase()}</b><small>${assignment}</small></span>
        <span class="deadzone-control">DEADZONE <output>${Math.round(item.deadzone * 100)}%</output>
          <input type="range" min="0" max="0.15" step="0.01" value="${item.deadzone}" data-deadzone="${kind}"></span></label>`;
    }).join('');
    this.element.querySelectorAll('[data-bind]').forEach(button => {
      const action = button.dataset.bind;
      const binding = config.buttons[action];
      button.textContent = this._binding === action ? 'PRESS A BUTTON…' : binding == null ? 'UNBOUND' : `BUTTON ${binding}`;
      button.classList.toggle('listening', this._binding === action);
    });
  }

  _tick() {
    if (!this.element.classList.contains('active')) { this.stop(); return; }
    const status = this.manager.refresh();
    const gamepad = this.manager.gamepad;
    const paintKey = gamepad
      ? `${this.manager.device?.profileKey}:${gamepad.index}`
      : null;
    if (paintKey !== this._paintKey) {
      this._paintKey = paintKey;
      if (this.manager.config) this._paintConfig();
    }
    if (status.connected) this._everConnected = true;
    this.element.querySelector('#wheel-device-state').textContent = status.connected
      ? 'CONNECTED'
      : this._everConnected ? 'AWAITING RECONNECT' : 'AWAITING BUTTON';
    this.element.querySelector('#wheel-device-state').classList.toggle('connected', !!status.connected);
    this.element.querySelector('#wheel-device-name').textContent = gamepad
      ? `${this.manager.device.label} · ${gamepad.axes.length} axes · ${gamepad.buttons.length} buttons`
      : 'Wheel detected? Press any button on your wheel to activate it.';
    this.element.querySelector('#wheel-profile-note').textContent = gamepad
      ? `Profile seed: ${this.manager.device.layoutKey} · ${this.manager.device.confidence}. Calibration overrides every seeded index.`
      : 'Gamepad devices are hidden by the browser until a button is pressed. A mouse click or keyboard press remains available for audio activation.';
    if (gamepad) {
      this.element.querySelector('#raw-axes').innerHTML = gamepad.axes.map((value, index) =>
        `<span class="raw-cell"><b>A${index}</b><i>${value.toFixed(3)}</i><em style="--axis:${((value + 1) * 50).toFixed(1)}%"></em></span>`).join('');
      this.element.querySelector('#raw-buttons').innerHTML = gamepad.buttons.map((button, index) =>
        `<span class="raw-cell ${button.pressed || button.value > 0.5 ? 'active' : ''}"><b>B${index}</b><i>${button.value.toFixed(2)}</i></span>`).join('');
      if (this._binding) {
        for (let index = 0; index < gamepad.buttons.length; index++) {
          const button = gamepad.buttons[index];
          if (this._bindingBaseline.has(index) && !button.pressed && button.value <= 0.5) {
            this._bindingBaseline.delete(index);
            continue;
          }
          if (!this._bindingBaseline.has(index) && (button.pressed || button.value > 0.5)) {
            const action = this._binding;
            this.manager.updateConfig(config => { config.buttons[action] = index; return config; });
            this._binding = null;
            this._setPrompt(`${action} saved to button ${index}.`);
            this._paintConfig();
            break;
          }
        }
      }
    } else {
      this.element.querySelector('#raw-axes').innerHTML = '<span class="raw-empty">Inputs appear after wheel-button activation</span>';
      this.element.querySelector('#raw-buttons').innerHTML = '<span class="raw-empty">Press any wheel button to activate detection</span>';
    }
    this._frame = requestAnimationFrame(() => this._tick());
  }
}
