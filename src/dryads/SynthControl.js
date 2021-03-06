
import {Dryad} from 'dryadic';
import {nodeSet} from '../server/osc/msg';
import * as _  from 'underscore';


/**
 * Sends nodeSet messages to the Synth in the parent context.
 *
 * This takes a Bacon.js stream which should return objects
 * {param: value, ...} and sends `nodeSet` messages to the parent Synth.
 *
 * SynthControl should be a child of a Synth, Group or other Dryad that
 * sets context.nodeID
 */
export default class SynthControl extends Dryad {

  /**
   * If there is no SCServer in the parent context,
   * then this will wrap itself in an SCServer
   */
  requireParent() {
    return 'SCServer';
  }

  add(player) {
    return {
      run: (context) => {
        if (this.properties.stream) {
          let subscription = this.properties.stream
            .subscribe((event) => {
              // This assumes a Bacon event.
              // Should validate that event.value is object
              let msg = nodeSet(context.nodeID, event.value());
              player.callCommand(context, {
                scserver: {
                  bundle: {
                    time: 0.03,
                    packets: [msg]
                  }
                }
              });
            });
          player.updateContext(context, {subscription});
        }
      }
    };
  }

  remove() {
    return {
      run: (context) => {
        if (context.subscription) {
          if (_.isFunction(context.subscription)) {
            // baconjs style
            context.subscription();
          } else {
            // Rx style
            context.subscription.dispose();
          }
        }
      }
    };
  }
}
