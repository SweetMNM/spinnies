'use strict';
const readline = require('readline');
const chalk = require('chalk');
const cliCursor = require('cli-cursor');
const EventEmitter = require('events').EventEmitter;
const EOL = require('os').EOL;
const { dashes, dots } = require('./spinners');

const { statusOptionsFromNormalUpdate, secondStageIndent, indentText, turnToValidSpinner, purgeSpinnerOptions, purgeSpinnersOptions, purgeStatusOptions, colorOptions, prefixOptions, breakText, getLinesLength, terminalSupportsUnicode } = require('./utils');
const { isValidStatus, writeStream, cleanStream } = require('./utils');

const DEFAULT_STATUS = 'spinning';

class StatusRegistry {
  constructor(defaultStatus) {
    this.defaultStatus = defaultStatus;
    this.statuses = {};
    this.statusesAliases = {};
  }

  configureStatus(name, statusOptions = {}) {
    if (!name) throw new Error('Status name must be a string');
    let { aliases } = statusOptions;
    const existingStatus = this.statuses[name] || {};
    const purgedOptions = purgeStatusOptions(statusOptions);

    const opts = {
      prefix: false,
      isStatic: false,
      noSpaceAfterPrefix: false,
      spinnerColor: 'cyan',
      prefixColor: 'cyan',
      textColor: false,
      ...existingStatus,
      ...purgedOptions
    }

    this.statuses[name] = opts;

    if (aliases) {
      aliases = Array.isArray(aliases) ? aliases : [aliases];
      aliases.forEach(aliasName => {
        if (typeof aliasName !== 'string') return;
        this.statusesAliases[aliasName] = name;
      });
    }

    return this;
  }

  getStatus(name) {
    const status = this.statuses[name];
    if (status) {
      return status;
    }

    const fromAlias = this.statusesAliases[name];
    if (fromAlias && this.statuses[fromAlias]) {
      return this.statuses[fromAlias];
    }

    return this.statuses[this.defaultStatus];
  }

  actualName(nameOrAlias) {
    if(this.statuses[nameOrAlias]) return nameOrAlias;
    return this.statusesAliases[nameOrAlias];
  }
};

class Spinnie extends EventEmitter {
  constructor({ name, options, inheritedOptions, statusRegistry, logs }) {
    super();

    if (!options.text) options.text = name;
    const spinnerProperties = {
      ...colorOptions(inheritedOptions),
      succeedPrefix: inheritedOptions.succeedPrefix,
      failPrefix: inheritedOptions.failPrefix,
      status: 'spinning',
      ...purgeSpinnerOptions(options),
    };

    this.logs = logs;
    this.options = spinnerProperties;
    this.statusRegistry = statusRegistry;
    this.statusOverrides = {};

    this.applyStatusOverrides(spinnerProperties);

    return this;
  }

  update(options = {}) {
    const { status } = options;
    this.setSpinnerProperties(options, status);
    this.updateSpinnerState();

    return this;
  }

  status(statusName) {
    if (!statusName || typeof statusName !== 'string') return this;
    this.options.status = statusName;
    this.updateSpinnerState();

    return this;
  }

  succeed(options = {}) {
    this.setSpinnerProperties(options, 'succeed');
    this.updateSpinnerState();

    return this;
  }

  fail(options = {}) {
    this.setSpinnerProperties(options, 'fail');
    this.updateSpinnerState();

    return this;
  }

  remove() {
    this.emit('removeMe');
  }

  applyStatusOverrides(opts) {
    const { shouldSetDefault, shouldSetFail, shouldSetSucceed, defaultSet, failSet, succeedSet } = statusOptionsFromNormalUpdate(opts);

    if (shouldSetDefault) {
      this.statusOverrides['spinning'] = defaultSet;
    }
    if (shouldSetFail) {
      this.statusOverrides['fail'] = failSet;
    }
    if (shouldSetSucceed) {
      this.statusOverrides['success'] = succeedSet;
    }
  }

  isActive() {
    return this.options.status === 'spinning';
  }

  rawRender() {
    const status = this.getStatus(this.options.status);
    const defaultRawRender = ({ statusOptions, text }) => {
      return `${statusOptions.prefix ? (chalk[statusOptions.prefixColor](statusOptions.prefix) + (status.noSpaceAfterPrefix ? '' : ' ')) : ''}${statusOptions.textColor ? chalk[statusOptions.textColor](text) : text}`;
    };
    const rawRenderFromStatus = status.rawRender;
    const render = rawRenderFromStatus ? rawRenderFromStatus : defaultRawRender;
    
    let output = render({
      text: this.options.text,
      options: this.options,
      statusOptions: status
    });

    const indent = this.options.indent;
    let prefixLengthToIndent = 0;
    if (!rawRenderFromStatus) {
      // if we use the default rawRender: indent by the prefix length, else by 0
      if (status.prefix) {
        // only if we have a prefix...
        prefixLengthToIndent = status.prefix.length;
        if (!status.noSpaceAfterPrefix) {
          // if we have a space after the prefix add 1 to the prefix length
          prefixLengthToIndent += 1;
        }
      }
    }

    output = breakText(output, 0, indent);
    output = indentText(output, prefixLengthToIndent, indent);
    output = secondStageIndent(output, indent);

    return output;
  }

  render(frame) {
    let { text, status, color, spinnerColor, succeedColor, failColor, succeedPrefix, failPrefix, indent } = this.options;
    let line;
    let prefixLength;
    if (status === 'spinning') {
      prefixLength = frame.length + 1;
      text = breakText(text, prefixLength, indent);
      text = indentText(text, prefixLength, indent);
      line = `${chalk[spinnerColor](frame)} ${color ? chalk[color](text) : text}`;
    } else {
      if (status === 'succeed') {
        prefixLength = succeedPrefix.length + 1;
        text = breakText(text, prefixLength, indent);
        text = indentText(text, prefixLength, indent);
        line = `${chalk.green(succeedPrefix)} ${chalk[succeedColor](text)}`;
      } else if (status === 'fail') {
        prefixLength = failPrefix.length + 1;
        text = breakText(text, prefixLength, indent);
        text = indentText(text, prefixLength, indent);
        line = `${chalk.red(failPrefix)} ${chalk[failColor](text)}`;
      } else {
        prefixLength = 0;
        text = breakText(text, prefixLength, indent);
        text = indentText(text, prefixLength, indent);
        line = color ? chalk[color](text) : text;
      }
    }

    const linesLength = getLinesLength(text, prefixLength, indent);
    const output = `${secondStageIndent(line, indent)}${EOL}`;
    return { output, linesLength };
  }

  addLog(log) {
    this.logs.push(log);
  }

  getStatus(name) {
    const override = this.statusOverrides[this.statusRegistry.actualName(name)] || {};
    return { ...this.statusRegistry.getStatus(name), ...override };
  }

  setSpinnerProperties(options, status) {
    this.applyStatusOverrides(options);
    options = purgeSpinnerOptions(options);
    status = status || this.options.status || 'spinning';

    this.options = { ...this.options, ...options, status };
    return this;
  }

  updateSpinnerState() {
    this.emit('updateSpinnerState');
  }
}

class Spinnies {
  constructor(options = {}) {
    options = purgeSpinnersOptions(options);
    this.options = {
      color: 'white',
      spinnerColor: 'greenBright',
      succeedColor: 'green',
      failColor: 'red',
      spinner: terminalSupportsUnicode() ? dots : dashes,
      disableSpins: false,
      ...options
    };

    this.logs = [];
    this.spinners = {};
    this.statusRegistry = new StatusRegistry(DEFAULT_STATUS);

    this.isCursorHidden = false;
    this.currentInterval = null;
    this.stream = process.stderr;
    this.lineCount = 0;
    this.currentFrameIndex = 0;
    this.spin = !this.options.disableSpins && !process.env.CI && process.stderr && process.stderr.isTTY;

    this.statusRegistry.configureStatus('spinning', {
      aliases: ['spin', 'active', 'default'],
      spinnerColor: this.options.color,
      textColor: this.options.color,
      prefix: '-',
      prefixColor: this.options.color
    });
    this.statusRegistry.configureStatus('success', {
      aliases: ['succeed', 'done'],
      prefix: this.options.succeedPrefix,
      isStatic: true,
      noSpaceAfterPrefix: false,
      prefixColor: this.options.succeedColor,
      textColor: this.options.succeedColor
    });
    this.statusRegistry.configureStatus('fail', {
      aliases: ['failed', 'error'],
      prefix: this.options.failPrefix,
      isStatic: true,
      noSpaceAfterPrefix: false,
      prefixColor: this.options.failColor,
      textColor: this.options.failColor
    });
    this.statusRegistry.configureStatus('non-spinnable', {
      aliases: ['static', 'inactive'],
      prefix: false,
      isStatic: true,
      rawRender({ text, options, statusOptions }) {
        return text;
      }
    });
    this.statusRegistry.configureStatus('stopped', {
      aliases: ['stop', 'cancel'],
      prefix: false,
      isStatic: true,
      textColor: 'grey',
      rawRender({ text, options, statusOptions }) {
        return text;
      }
    });

    this.bindSigint();
  }

  addLog(str) {
    this.logs.push(str);
  }

  get(name) {
    return this.spinners[name];
  }

  pick(name) {
    return this.spinners[name].options;
  }

  setFrames(frames) {
    const spinner = turnToValidSpinner(frames);
    this.options.spinner = spinner;
    this.currentFrameIndex = 0;
    this.updateSpinnerState();

    return this;
  }

  add(name, options = {}) {
    if (typeof name !== 'string') throw new Error('A spinner reference name must be specified');
    if (this.spinners[name] !== undefined) throw new Error(`A spinner named '${name}' already exists`);

    const spinnie = new Spinnie({ name, options, inheritedOptions: this.options, statusRegistry: this.statusRegistry, logs: this.logs });

    spinnie.on('removeMe', () => {
      this.remove(name);
    }).on('updateSpinnerState', () => {
      this.updateSpinnerState();
    });

    this.spinners[name] = spinnie;

    this.updateSpinnerState();

    return spinnie;
  }

  update(name, options = {}) {
    return this.childFuction(name, 'update', options);
  }

  status(name, statusName) {
    return this.childFuction(name, 'status', statusName);
  }

  succeed(name, options = {}) {
    return this.childFuction(name, 'succeed', options);
  }

  fail(name, options = {}) {
    return this.childFuction(name, 'fail', options);
  }

  remove(name) {
    this.get(name).removeAllListeners();
    delete this.spinners[name];
    this.updateSpinnerState();
  }

  stopAll(newStatus = 'stopped') {
    Object.keys(this.spinners).forEach(name => {
      const currentSpinner = this.get(name);
      const currentStatus = currentSpinner.options.status;
      if (currentStatus !== 'fail' && currentStatus !== 'succeed' && currentStatus !== 'non-spinnable') {
        if (newStatus === 'succeed' || newStatus === 'fail') {
          currentSpinner.options.status = newStatus;
          currentSpinner.options.color = this.options[`${newStatus}Color`];
        } else {
          currentSpinner.options.status = 'stopped';
          currentSpinner.options.color = 'grey';
        }
      }
    });
    this.checkIfActiveSpinners();

    return this.spinners;
  }

  hasActiveSpinners() {
    return !!Object.values(this.spinners).find((spinner) => spinner.isActive());
  }

  setSpinnerProperties(name, options, status) {
    return this.childFuction(name, 'setSpinnerProperties', options, status);
  }

  updateSpinnerState(name, options = {}, status) {
    if (this.spin) {
      clearInterval(this.currentInterval);
      this.currentInterval = this.loopStream();
      if (!this.isCursonHidden) cliCursor.hide();
      this.isCursorHidden = true;
      this.checkIfActiveSpinners();
    } else {
      this.setRawStreamOutput();
    }
  }

  loopStream() {
    const { frames, interval } = this.options.spinner;
    return setInterval(() => {
      this.setStreamOutput(frames[this.currentFrameIndex]);
      this.currentFrameIndex = this.currentFrameIndex === frames.length - 1 ? 0 : ++this.currentFrameIndex
    }, interval);
  }

  setStreamOutput(frame = '') {
    let output = '';
    const linesLength = [];
    const hasActiveSpinners = this.hasActiveSpinners();
    Object
      .keys(this.spinners)
      .forEach((name) => {
        const renderedSpinner = this.get(name).render(frame);

        linesLength.push(...renderedSpinner.linesLength);
        output += renderedSpinner.output;
      });

    if(!hasActiveSpinners) readline.clearScreenDown(this.stream);
    writeStream(this.stream, output, linesLength);
    if (hasActiveSpinners) cleanStream(this.stream, linesLength);
    this.lineCount = linesLength.length;
  }

  setRawStreamOutput() {
    Object.keys(this.spinners).forEach(name => {
      const spinner = this.get(name);
      process.stderr.write(spinner.rawRender() + EOL);
    });
  }

  checkIfActiveSpinners() {
    if (!this.hasActiveSpinners()) {
      if (this.spin) {
        this.setStreamOutput();
        readline.moveCursor(this.stream, 0, this.lineCount);
        clearInterval(this.currentInterval);
        this.isCursorHidden = false;
        cliCursor.show();
      }
      this.spinners = {};
    }
  }

  childFuction(name, action, ...args) {
    if (typeof name !== 'string') throw Error('A spinner reference name must be specified');
    if (!this.get(name)) throw Error(`No spinner initialized with name ${name}`);

    const spinner = this.get(name);
    spinner[action](...args);
    return spinner;
  }

  bindSigint(lines) {
    process.removeAllListeners('SIGINT');
    process.on('SIGINT', () => {
      cliCursor.show();
      readline.moveCursor(process.stderr, 0, this.lineCount);
      process.exit(0);
    });
  }

  log(method = console.log) {
    this.logs.forEach((log) => method(log));
  }

  getLogs() {
    return this.logs;
  }
}

module.exports = Spinnies;
module.exports.dots = dots;
module.exports.dashes = dashes;
module.exports.StatusRegistry = StatusRegistry;
