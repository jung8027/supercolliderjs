/* @flow */
import {Dryad} from 'dryadic';
import {boot} from '../lang/sclang';
import * as _ from 'underscore';

const defaultOptions = {
  debug: true,
  echo: false,
  stdin: false
};

/**
 * Boots a new SuperCollider language interpreter (sclang) making it available for all children as context.sclang
 *
 * Always boots a new one, ignoring any possibly already existing one in the parent context.
 *
 * `options` are the command line options supplied to sclang (note: not all options are passed through yet)
 * see {@link lang/SCLang}
 *
 * Not to be confused with the other class named SCLang which does all the hard work.
 * This Dryad class is just a simple wrapper around that.
 */
export default class SCLang extends Dryad {

  defaultProperties() {
    return {
      options: defaultOptions
    };
  }

  prepareForAdd() {
    return {
      sclang: (context: Object) => boot(_.defaults(this.properties.options, {log: context.log}))
    };
  }

  remove() {
    return {
      run: (context: Object) => {
        return context.sclang.quit();
      }
    };
  }
}
