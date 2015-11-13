/**
 *
 * scsynth - boots a supercollider synthesis server process
 *
 *  SuperCollider comes with an executable called scsynth
 *  which can be communicated with via udp OSC
 *
 *  The primary way to send messages in with sendMsg
 *  eg. server.sendMsg('/s_new', ['defName', 440])

 *  and the responses are emitted as 'OSC'
 *  eg. server.on('OSC', function(msg) {  ...  });
 *
 * methods:
 *   boot        - boot an scsynth process
 *   quit
 *   connect     - connect via udp OSC
 *   disconnect
 *   sendMsg     - send an OSC message
 *
 * emits:
 *    'out'   - stdout text from the server
 *    'error' - stderr text from the server or OSC error messages
 *    'exit'  - when server exits
 *    'close' - when server closes the UDP connection
 *    'OSC'   - OSC responses from the server
 */

import {EventEmitter} from 'events';
import {Observable, Subject} from 'Rx';
import {spawn} from 'child_process';
import * as _ from 'underscore';
import * as dgram from 'dgram';
import * as osc from 'osc-min';
import * as Q from 'q';
import Immutable from 'immutable';

import * as alloc from './internals/allocators';
import defaultOptions from './default-server-options';
import Logger from '../utils/Logger';
import resolveOptions from '../utils/resolveOptions';


const keys = {
  NODE_IDS: 'nodeAllocator',
  CONTROL_BUSSES: 'controlBusAllocator',
  AUDIO_BUSSES: 'audioBusAllocator',
  BUFFERS: 'bufferAllocator'
};


class SendOSC extends EventEmitter {

  msg(m) {
    this.emit('msg', m);
  }

  bundle(b) {
    throw new Error('Not yet implemented');
    // not yet implemented
    // this will need a time
    // this.emit('bundle', b);
  }

  /**
   * Subscribe to monitor messages and bundles sent.
   *
   * Events are: {type: msg|bundle: payload: Array}
   *
   * @returns {Rx.Disposable} - `thing.dispose();` to unsubscribe
   */
  subscribe(onNext, onError, onComplete) {
    var msgs = Observable.fromEvent(this, 'msg', (msg) => {
      return {type: 'msg', payload: msg};
    });
    var bundles = Observable.fromEvent(this, 'bundle', (msg) => {
      return {type: 'bundle', payload: msg};
    });
    var combo = msgs.merge(bundles);
    return combo.subscribe(onNext, onError, onComplete);
  }
}

function _noop() {}


export class Server extends EventEmitter {

  /**
   * @param {Object} options - command line options for scsynth
   */
  constructor(options={}) {
    super();
    this.options = _.defaults(options, defaultOptions);
    this.process = null;
    this.isRunning = false;

    // subscribeable streams
    this.send = new SendOSC();
    this.receive  = new Subject();
    this.stdout = new Subject();
    this.processEvents = new Subject();

    this._initLogger();
    this._initEmitter();
    this._initSender();

    this._serverObservers = {};
    this.resetState();
  }

  _initLogger() {
    this.log = new Logger(this.options.debug, this.options.echo);
    this.send.subscribe((event) => {
      // will be a type:msg or type:bundle
      var out;
      if (event.type === 'msg') {
        out = event.payload.join(' ');
      } else {
        out = String(event.payload);
      }
      if (!this.osc) {
        out = '[NOT CONNECTED] ' + out;
      }
      this.log.sendosc(out);
    });
    this.receive.subscribe((o) => this.log.rcvosc(o));
    this.stdout.subscribe((o) => this.log.stdout(o), (o) => this.log.stderr(o));
    this.processEvents.subscribe((o) => this.log.dbug(o), (o) => this.log.err(o));
  }
  _initEmitter() {
    // emit signals are deprecated.
    // use server.{channel}.subscribe((event) => { })
    this.receive.subscribe((msg) => {
      this.emit('OSC', msg);
    });
    this.processEvents.subscribe(_noop, (err) => this.emit('exit', err));
    this.stdout.subscribe((out) => this.emit('out', out), (out) => this.emit('stderr', out));
  }
  _initSender() {
    this.send.on('msg', (msg) => {
      if (this.osc) {
        var buf = osc.toBuffer({
          address: msg[0],
          args: msg.slice(1)
        });
        this.osc.send(buf, 0, buf.length, this.options.serverPort, this.options.host);
      }
    });
  }

  resetState() {
    var state = Immutable.Map();
    state = state.set(keys.NODE_IDS, this.options.initialNodeID - 1);

    var numAudioChannels = this.options.numPrivateAudioBusChannels +
      this.options.numInputBusChannels +
      this.options.numOutputBusChannels;
    var ab = alloc.initialBlockState(numAudioChannels);
    ab = alloc.reserveBlock(ab, 0, this.options.numInputBusChannels + this.options.numOutputBusChannels);
    state = state.set(keys.AUDIO_BUSSES, ab);

    var cb = alloc.initialBlockState(this.options.numControlBusChannels);
    state = state.set(keys.CONTROL_BUSSES, cb);

    var bb = alloc.initialBlockState(this.options.numBuffers);
    state = state.set(keys.BUFFERS, cb);

    this.state = state;
  }

  /**
   * Format command line args for scsynth
   *
   * not yet fully implemented
   *
   * @return {array} list of non-default args
   */
  args() {
    var o = [];
    o.push(this.options.protocol === 'udp' ? '-u' : '-t');
    o.push(this.options.serverPort);
    return o;
  }

  /**
   * boot
   *
   * start scsynth and establish a pipe connection
   * to receive stdout and stderr
   *
   * listen for system events and emit: exit out error
   */
  boot() {
    var
      self = this,
      execPath = this.options.scsynth,
      args = this.args(),
      d = Q.defer();

    this.isRunning = false;

    this.processEvents.onNext(execPath + ' ' + args.join(' '));

    this.process = spawn(execPath, args, {
        cwd: this.options.cwd
      });
    this.processEvents.onNext('pid: ' + this.process.pid);

    this.process.on('error', (err) => {
      this.processEvents.onError(err);
      this.isRunning = false;
      // this.disconnect()
    });
    this.process.on('close', (code, signal) => {
      this.processEvents.onError('Server closed. Exit code: ' + code + ' signal: ' + signal);
      this.isRunning = false;
      // this.disconnect()
    });
    this.process.on('exit', (code, signal) => {
      this.processEvents.onError('Server exited. Exit code: ' + code + ' signal: ' + signal);
      this.isRunning = false;
      // this.disconnect()
    });

    this._serverObservers.stdout = Observable.fromEvent(this.process.stdout, 'data', (data) => String(data));
    this._serverObservers.stdout.subscribe((e) => this.stdout.onNext(e));

    this._serverObservers.stderr = Observable.fromEvent(this.process.stderr, 'data')
      .subscribe((out) => {
        console.log('stderr', out);
        // just pipe it into the stdout object's error stream
        this.stdout.onError(out);
      });

    // watch for ready message
    this._serverObservers.stdout.takeWhile((text) => (text.match(/SuperCollider 3 server ready/) !== null))
      .subscribe((next) => {},
        this.log.err,
        () => { // onComplete
          this.isRunning = true;
          d.resolve();
        });

    setTimeout(() => {
      if (!this.isRunning) {
        d.reject();
      }
    }, 3000);

    return d.promise;
  }

  /**
   * quit
   *
   * kill scsynth process
   */
  quit() {
    if (this.process) {
      this.process.kill('SIGTERM');
      this.process = null;
    }
  }

  /**
   * Establish connection to scsynth via OSC socket
   */
  connect() {
    var self = this;
    this.osc = dgram.createSocket('udp4');

    // pipe events to this.receive
    this._serverObservers.oscMessage = Observable.fromEvent(this.osc, 'message', (msgbuf) => osc.fromBuffer(msgbuf));
    this._serverObservers.oscMessage.subscribe((e) => this.receive.onNext(e));

    this._serverObservers.oscError = Observable.fromEvent(this.osc, 'error');
    this._serverObservers.oscError.subscribe((e) => this.receive.onError(e));

    this.osc.on('listening', () => {
      this.processEvents.onNext('udp is listening');
    });
    this.osc.on('close', (e) => {
      this.processEvents.onNext('udp closed: ' + e);
      // destroy and unsub
    });
  }

  disconnect() {
    if (this.osc) {
      this.osc.close();
      delete this.osc;
    }
    this._serverObservers.forEach((obs, k) => {
      obs.dispose();
    });
    this._serverObservers = {};
  }

  /**
   * Send OSC message to server
   *
   * @deprecated - use: `server.send.msg([address, arg1, arg2])``
   * @param {String} address - OSC command, referred to as address
   * @param {Array} args
   */
  sendMsg(address, args) {
    this.send.msg([address].concat(args));
  }

  nextNodeID() {
    return this._mutateState(keys.NODE_IDS, alloc.increment);
  }

  // temporary raw allocator calls
  allocAudioBus(numChannels=1) {
    return this._allocBlock(keys.AUDIO_BUSSES, numChannels);
  }
  allocControlBus(numChannels=1) {
    return this._allocBlock(keys.CONTROL_BUSSES, numChannels);
  }
  /**
   * Allocate a buffer id.
   *
   * Note that numChannels is specified when creating the buffer.
   *
   * @param {int} numConsecutive - consecutively numbered buffers are needed by VOsc and VOsc3.
   * @returns {int}
   */
  allocBufferID(numConsecutive=1) {
    return this._allocBlock(keys.BUFFERS, numConsecutive);
  }

  // these require you to remember the channels and mess it up
  // if you free it wrong
  freeAudioBus(index, numChannels) {
    return this._freeBlock(keys.AUDIO_BUSSES, index, numChannels);
  }
  freeControlBus(index, numChannels) {
    return this._freeBlock(keys.CONTROL_BUSSES, index, numChannels);
  }
  freeBuffer(index, numChannels) {
    return this._freeBlock(keys.BUFFERS, index, numChannels);
  }

  // private
  /**
   * Fetch one part of the state,
   * mutate it with the callback,
   * save state and return the result.
   *
   * @returns {any} result
   */
  _mutateState(key, fn) {
    var result, state;
    [result, state] = fn(this.state.get(key));
    this.state = this.state.set(key, state);
    return result;
  }
  _mutateStateNoReturn(key, fn) {
    var state = fn(this.state.get(key));
    this.state = this.state.set(key, state);
  }
  _allocBlock(key, numChannels) {
    return this._mutateState(key,
      (state) => alloc.allocBlock(state, numChannels));
  }
  _freeBlock(key, index, numChannels) {
    return this._mutateStateNoReturn(key,
      (state) => alloc.freeBlock(state, index, numChannels));
  }
}

/**
 * boot a server with options
 * @returns {Promise}
 */
export function boot(options) {
  return resolveOptions(null, options).then(function(opts) {
    var s = new Server(opts);
    return s.boot().then(function() {
      s.connect();
      return s;
    });
  });
}
