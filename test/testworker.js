/**
 * This module spawns an instance of the worker, then submits a given task for
 * this automatically generated workerType and listens for the task completion
 * event.
 */
var slugid = require('slugid');
var request = require('superagent-promise');
var debug = require('debug')('docker-worker:test:testworker');
var util = require('util');
var waitForEvent = require('../lib/wait_for_event');
var split = require('split2');
var loadConfig = require('taskcluster-base/config');
var getArtifact = require('./integration/helper/get_artifact');

var Task = require('taskcluster-task-factory/task');
var LocalWorker = require('./localworker');
var Queue  = require('taskcluster-client').Queue;
var Scheduler = require('taskcluster-client').Scheduler;
var Listener = require('taskcluster-client').Listener;
var Promise = require('promise');
var EventEmitter = require('events').EventEmitter;

var queueEvents = new (require('taskcluster-client').QueueEvents);

/** Test provisioner id, don't change this... */
var PROVISIONER_ID = 'no-provisioning-nope';

function TestWorker(Worker, workerType, workerId) {
  // Load the test time configuration for all the components...
  var config = loadConfig({
    defaults: require('../config/defaults'),
    profile: require('../config/test'),
    filename: 'docker-worker-test'
  });

  this.workerType = workerType || slugid.v4();
  this.workerId = workerId || this.workerType;
  this.worker = new Worker(PROVISIONER_ID, this.workerType, this.workerId);

  this.queue = new Queue({
    credentials: config.get('taskcluster')
  });

  this.scheduler = new Scheduler({
    credentials: config.get('taskcluster')
  });

  EventEmitter.call(this);
}

TestWorker.prototype = {
  __proto__: EventEmitter.prototype,

  /**
  Ensure the worker is connected.
  */
  launch: function* () {
    var proc = yield this.worker.launch();

    // Proxy the exit event so we don't need to query .worker.
    this.worker.process.once('exit', this.emit.bind(this, 'exit'));

    // Process the output(s) to emit events based on the json streams.

    // stderr should not contain any useful logs so just pipe it...
    proc.stderr.pipe(process.stderr);

    // Parse stdout and emit non-json bits to stdout.
    proc.stdout.pipe(split(function(line) {
      try {
        var parsed = JSON.parse(line);
        debug('emit', parsed.type, parsed);
        this.emit(parsed.type, parsed);
      } catch (e) {
        // This is an intentional console log for any line which is not a
        // newline delimited json string.
        console.log(line);
      }
    }.bind(this)));

    // Wait for start event.
    yield waitForEvent(this, 'start');
  },

  terminate: function* () {
    return yield this.worker.terminate();
  },

  /**
  Post a single task to the queue.

  @param {String} taskId in slugid.v4 format.
  @param {Object} payload for the task.
  */
  createTask: function* (taskId, payload) {
    var deadline = new Date();
    deadline.setMinutes(deadline.getMinutes() + 10);

    var task = Task.create({
      payload: payload,
      provisionerId: PROVISIONER_ID,
      workerType: this.workerType,
      deadline: deadline.toJSON(),
      scopes: [],
      metadata: {
        owner: 'unkown@localhost.local',
        name: 'Task from docker-worker test suite',
      }
    });

    debug('post to queue %j', task);
    return yield this.queue.createTask(taskId, task);
  },


  /**
  Post a task to the graph with the testing configuration.

  @param {Object} payload for the task.
  */
  createGraph: function* (payload) {
    var deadline = new Date();
    deadline.setMinutes(deadline.getMinutes() + 10);

    var task = Task.create({
      payload: payload,
      provisionerId: '{{provisionerId}}',
      workerType: '{{workerType}}',
      deadline: deadline.toJSON(),
      timeout: 30,
      metadata: {
        owner: 'unkown@localhost.local',
        name: 'Task from docker-worker test suite',
      }
    });

    return yield this.scheduler.createTaskGraph({
      version: '0.2.0',
      tags: {},
      routing: '',
      params: {
        workerType: this.workerType,
        provisionerId: PROVISIONER_ID
      },
      metadata: task.metadata,
      tasks: [{
        label: 'test_task',
        requires: [],
        reruns: 0,
        task: task
      }]
    });
  },

  /**
  Fetch all the common stats used by the tests.
  */
  fetchTaskStats: function* (taskId, runId) {
    var fetch = yield {
      // Just about every single test needs status of the task...
      status: this.queue.status(taskId),

      // Live logging of the task...
      log: getArtifact(
        { taskId: taskId, runId: runId }, 'public/logs/terminal_live.log'
      ),

      // Generally useful for most of the tests...
      artifacts: this.queue.getArtifactsFromRun(taskId, runId),
    };

    // XXX: Ugh status.status...
    var status = fetch.status.status;
    var indexedArtifacts =
      fetch.artifacts.artifacts.reduce(function(result, artifact) {
        result[artifact.name] = artifact;
        return result;
      }, {});

    return {
      status: status,
      log: fetch.log,
      artifacts: indexedArtifacts,

      // Current run useful for .success, etc...
      run: status.runs[runId],

      // Useful if you need to run a secondary queue run, etc...
      taskId: taskId,
      runId: runId
    };
  },

  /**
  Post a message to the queue and wait for the results.

  @param {Object} payload for the worker.
  */
  postToQueue: function* (payload) {
    var taskId = slugid.v4();

    // Create and bind the listener which will notify us when the worker
    // completes a task.
    var listener = new Listener({
      connectionString: (yield this.queue.getAMQPConnectionString()).url
    });

    // listen for this one task and only this task...
    yield listener.bind(queueEvents.taskCompleted({
      taskId: taskId
    }));

    yield listener.connect();
    yield listener.resume();

    // Begin listening at the same time we create the task to ensure we get the
    // message at the correct time.
    var creation = yield [
      waitForEvent(listener, 'message'),
      this.createTask(taskId, payload),
    ];

    // Fetch the final result json.
    var status = creation.shift().payload.status;
    var runId = status.runs.pop().runId;

    // Close listener we only care about one message at a time.
    try {
      yield listener.close();
    } catch(e) {
      console.log('error during close:', e);
    }

    // Return uniform stats on the worker run (fetching common useful things).
    return yield this.fetchTaskStats(taskId, runId);
  },

  /**
  Post a task and await it's completion. Note that it is _not_ safe to run this
  method concurrently if you wish the results to match the input.
  */
  post: function* (payload) {
    // Create and bind the listener which will notify us when the worker
    // completes a task.
    var listener = new Listener({
      connectionString: (yield this.queue.getAMQPConnectionString()).url
    });

    // TODO: Use our own task id's when possible.
    yield listener.bind(queueEvents.taskCompleted({
      workerId: this.workerId,
      workerType: this.workerType,
      provisionerId: PROVISIONER_ID
    }));

    yield listener.connect();

    // Begin listening at the same time we create the task to ensure we get the
    // message at the correct time.
    var creation = yield [
      waitForEvent(listener, 'message'),
      this.createGraph(payload),
      listener.resume()
    ];

    // Fetch the final result json.
    var status = creation.shift().payload.status;
    var taskId = status.taskId;
    var runId = status.runs.pop().runId;

    //var results = yield {
      //result: getBody(taskUrl('%s/runs/%s/result.json', taskId, runId)),
      //logs: getBody(taskUrl('%s/runs/%s/logs.json', taskId, runId)),
      //taskId: taskId
    //};

    // Close listener we only care about one message at a time.
    yield listener.close();

    return status;
  }
};

module.exports = TestWorker;
