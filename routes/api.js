
const express = require('express');
const mongoose = require('mongoose');
const User = require('../models/user');
const Task = require('../models/task');

const router = express.Router();

// Standard API errors
class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const fail = (status, message) => {
  throw new ApiError(status, message);
};

const ok = (res, data, status = 200, message = 'OK') =>
  res.status(status).json({ message, data });

const isObj = v =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

const isId = v =>
  typeof v === 'string' && mongoose.isValidObjectId(v);

const has = (o, k) =>
  Object.prototype.hasOwnProperty.call(o, k);

// Validate strings
const string = (v, field, required = false) => {
  if (typeof v !== 'string' || (required && !v.trim())) {
    fail(400, `Invalid ${field}`);
  }
  return v;
};

// Validate allowed fields
const validKeys = (obj, keys) => {
  if (!isObj(obj)) {
    fail(400, 'Expected a JSON object');
  }

  for (const key of Object.keys(obj)) {
    if (!keys.includes(key)) {
      fail(400, `Unexpected field: ${key}`);
    }
  }
};

// Validate dates
const validDate = (v, field) => {
  if (
    typeof v !== 'string' &&
    typeof v !== 'number' &&
    !(v instanceof Date)
  ) {
    fail(400, `Invalid ${field}`);
  }

  const d = new Date(v);

  if (!Number.isFinite(d.getTime())) {
    fail(400, `Invalid ${field}`);
  }

  return d;
};

// Validate user request body
function userBody(body) {
  validKeys(body, ['name', 'email', 'pendingTasks']);

  const name = string(body.name, 'name', true);
  const email = string(body.email, 'email', true);

  const pendingTasks = has(body, 'pendingTasks')
    ? body.pendingTasks
    : [];

  if (
    !Array.isArray(pendingTasks) ||
    pendingTasks.some(x => !isId(x))
  ) {
    fail(400, 'Invalid pendingTasks');
  }

  if (new Set(pendingTasks).size !== pendingTasks.length) {
    fail(400, 'Duplicate pendingTasks');
  }

  return { name, email, pendingTasks };
}

// Validate task request body
function taskBody(body) {
  validKeys(body, [
    'name',
    'description',
    'deadline',
    'completed',
    'assignedUser',
    'assignedUserName'
  ]);

  const name = string(body.name, 'name', true);
  const deadline = validDate(body.deadline, 'deadline');

  const description = has(body, 'description')
    ? string(body.description, 'description')
    : '';

  const completed = has(body, 'completed')
    ? body.completed
    : false;

  if (typeof completed !== 'boolean') {
    fail(400, 'Invalid completed');
  }

  const assignedUser = has(body, 'assignedUser')
    ? string(body.assignedUser, 'assignedUser')
    : '';

  if (assignedUser !== '' && !isId(assignedUser)) {
    fail(400, 'Invalid assignedUser');
  }

  const assignedUserName = has(body, 'assignedUserName')
    ? string(body.assignedUserName, 'assignedUserName')
    : undefined;

  if (
    assignedUser === '' &&
    assignedUserName !== undefined &&
    assignedUserName !== 'unassigned'
  ) {
    fail(400, 'Invalid assignedUserName');
  }

  return {
    name,
    deadline,
    description,
    completed,
    assignedUser,
    assignedUserName
  };
}

// Execute related database changes atomically
async function withTransaction(fn) {
  const session = await mongoose.startSession();

  try {
    return await session.withTransaction(() => fn(session));
  } finally {
    await session.endSession();
  }
}

// Parse JSON query parameters
function parseJsonParam(raw, name) {
  if (raw === undefined) return undefined;

  if (typeof raw !== 'string') {
    fail(400, `Invalid ${name}`);
  }

  try {
    const obj = JSON.parse(raw);

    if (!isObj(obj)) {
      fail(400, `Invalid ${name}`);
    }

    return obj;
  } catch (err) {
    if (err instanceof ApiError) throw err;
    fail(400, `Invalid ${name}`);
  }
}

// Handle select parameter
function projection(raw) {
  const value = parseJsonParam(raw, 'select');

  if (value) {
    for (const v of Object.values(value)) {
      if (v !== 0 && v !== 1) {
        fail(400, 'Invalid select');
      }
    }
  }

  return value;
}

// Parse collection query options
function collectionOptions(q, type) {
  const where = parseJsonParam(q.where, 'where') || {};
  const sort = parseJsonParam(q.sort, 'sort');

  if (sort) {
    for (const v of Object.values(sort)) {
      if (v !== 1 && v !== -1) {
        fail(400, 'Invalid sort');
      }
    }
  }

  const select = projection(q.select);

  function nonnegative(raw, name, fallback) {
    if (raw === undefined) return fallback;

    if (
      typeof raw !== 'string' ||
      !/^\d+$/.test(raw) ||
      !Number.isSafeInteger(Number(raw))
    ) {
      fail(400, `Invalid ${name}`);
    }

    return Number(raw);
  }

  const skip = nonnegative(q.skip, 'skip', 0);

  const limit = nonnegative(
    q.limit,
    'limit',
    type === 'tasks' ? 100 : undefined
  );

  if (
    q.count !== undefined &&
    q.count !== 'true' &&
    q.count !== 'false'
  ) {
    fail(400, 'Invalid count');
  }

  return {
    where,
    sort,
    select,
    skip,
    limit,
    count: q.count === 'true'
  };
}

// Reject unsafe query operators
function safeQuery(obj) {
  if (Array.isArray(obj)) {
    return obj.forEach(safeQuery);
  }

  if (!isObj(obj)) return;

  for (const [key, value] of Object.entries(obj)) {
    if ([
      '__proto__',
      'constructor',
      'prototype',
      '$where',
      '$function',
      '$accumulator'
    ].includes(key)) {
      fail(400, 'Invalid query');
    }

    safeQuery(value);
  }
}

// Handle asynchronous route errors
function asyncRoute(fn) {
  return (req, res, next) =>
    Promise.resolve()
      .then(() => fn(req, res))
      .catch(next);
}

// GET collections and individual resources
for (const [path, Model, type] of [
  ['/users', User, 'users'],
  ['/tasks', Task, 'tasks']
]) {
  router.get(path, asyncRoute(async (req, res) => {
    const p = collectionOptions(req.query, type);

    safeQuery(p.where);

    if (p.count) {
      return ok(res, await Model.countDocuments(p.where));
    }

    let query = Model.find(p.where);

    if (p.sort) query = query.sort(p.sort);
    if (p.select) query = query.select(p.select);
    if (p.skip) query = query.skip(p.skip);

    if (p.limit !== undefined) {
      query = query.limit(p.limit);
    }

    ok(res, await query.lean());
  }));

  router.get(`${path}/:id`, asyncRoute(async (req, res) => {
    if (!isId(req.params.id)) {
      fail(404, 'Not found');
    }

    const select = projection(req.query.select);

    const doc = await Model.findById(req.params.id)
      .select(select || {})
      .lean();

    if (!doc) {
      fail(404, 'Not found');
    }

    ok(res, doc);
  }));
}

// Create or replace a user
async function saveUser(body, id, session) {
  if (id && !isId(id)) {
    fail(404, 'User not found');
  }

  const previous = id
    ? await User.findById(id).session(session)
    : null;

  if (id && !previous) {
    fail(404, 'User not found');
  }

  const data = userBody(body);

  const duplicate = await User.findOne({
    email: data.email,
    ...(id ? { _id: { $ne: id } } : {})
  }).session(session);

  if (duplicate) {
    fail(400, 'Email already in use');
  }

  const tasks = await Task.find({
    _id: { $in: data.pendingTasks }
  }).session(session);

  if (tasks.length !== data.pendingTasks.length) {
    fail(404, 'Referenced task not found');
  }

  if (tasks.some(t => t.completed)) {
    fail(400, 'Completed tasks cannot be pending');
  }

  let user;

  if (previous) {
    previous.name = data.name;
    previous.email = data.email;
    previous.pendingTasks = data.pendingTasks;

    await previous.save({ session });
    user = previous;
  } else {
    [user] = await User.create([data], { session });
  }

  const userId = String(user._id);

  // Unassign pending tasks removed from this user
  await Task.updateMany(
    {
      assignedUser: userId,
      completed: false,
      _id: { $nin: data.pendingTasks }
    },
    {
      $set: {
        assignedUser: '',
        assignedUserName: 'unassigned'
      }
    },
    { session }
  );

  // Remove transferred tasks from previous users
  await User.updateMany(
    { _id: { $ne: user._id } },
    {
      $pull: {
        pendingTasks: { $in: data.pendingTasks }
      }
    },
    { session }
  );

  // Assign selected tasks to this user
  if (data.pendingTasks.length) {
    await Task.updateMany(
      { _id: { $in: data.pendingTasks } },
      {
        $set: {
          assignedUser: userId,
          assignedUserName: user.name
        }
      },
      { session }
    );
  }

  // Keep task owner names synchronized
  await Task.updateMany(
    { assignedUser: userId },
    { $set: { assignedUserName: user.name } },
    { session }
  );

  return User.findById(user._id)
    .session(session)
    .lean();
}

// Create or replace a task
async function saveTask(body, id, session) {
  if (id && !isId(id)) {
    fail(404, 'Task not found');
  }

  const previous = id
    ? await Task.findById(id).session(session)
    : null;

  if (id && !previous) {
    fail(404, 'Task not found');
  }

  const data = taskBody(body);

  const owner = data.assignedUser
    ? await User.findById(data.assignedUser).session(session)
    : null;

  if (data.assignedUser && !owner) {
    fail(404, 'Assigned user not found');
  }

  if (
    owner &&
    data.assignedUserName !== undefined &&
    data.assignedUserName !== owner.name
  ) {
    fail(400, 'assignedUserName does not match assigned user');
  }

  data.assignedUserName = owner
    ? owner.name
    : 'unassigned';

  let task;

  if (previous) {
    Object.assign(previous, data);
    await previous.save({ session });
    task = previous;
  } else {
    [task] = await Task.create([data], { session });
  }

  const taskId = String(task._id);

  // Remove task from all pending task lists
  await User.updateMany(
    { pendingTasks: taskId },
    { $pull: { pendingTasks: taskId } },
    { session }
  );

  // Add task to owner only if incomplete
  if (owner && !data.completed) {
    await User.updateOne(
      { _id: owner._id },
      { $addToSet: { pendingTasks: taskId } },
      { session }
    );
  }

  return Task.findById(task._id)
    .session(session)
    .lean();
}

// POST users
router.post('/users', asyncRoute(async (req, res) => {
  const user = await withTransaction(
    session => saveUser(req.body, null, session)
  );

  ok(res, user, 201, 'User created');
}));

// PUT users
router.put('/users/:id', asyncRoute(async (req, res) => {
  const user = await withTransaction(
    session => saveUser(req.body, req.params.id, session)
  );

  ok(res, user, 200, 'User updated');
}));

// POST tasks
router.post('/tasks', asyncRoute(async (req, res) => {
  const task = await withTransaction(
    session => saveTask(req.body, null, session)
  );

  ok(res, task, 201, 'Task created');
}));

// PUT tasks
router.put('/tasks/:id', asyncRoute(async (req, res) => {
  const task = await withTransaction(
    session => saveTask(req.body, req.params.id, session)
  );

  ok(res, task, 200, 'Task updated');
}));

// DELETE tasks
router.delete('/tasks/:id', asyncRoute(async (req, res) => {
  if (!isId(req.params.id)) {
    fail(404, 'Task not found');
  }

  await withTransaction(async session => {
    const task = await Task.findById(req.params.id)
      .session(session);

    if (!task) {
      fail(404, 'Task not found');
    }

    await User.updateMany(
      { pendingTasks: String(task._id) },
      { $pull: { pendingTasks: String(task._id) } },
      { session }
    );

    await Task.deleteOne({ _id: task._id })
      .session(session);
  });

  res.status(204).end();
}));

// DELETE users
router.delete('/users/:id', asyncRoute(async (req, res) => {
  if (!isId(req.params.id)) {
    fail(404, 'User not found');
  }

  await withTransaction(async session => {
    const user = await User.findById(req.params.id)
      .session(session);

    if (!user) {
      fail(404, 'User not found');
    }

    await Task.updateMany(
      { assignedUser: String(user._id) },
      {
        $set: {
          assignedUser: '',
          assignedUserName: 'unassigned'
        }
      },
      { session }
    );

    await User.deleteOne({ _id: user._id })
      .session(session);
  });

  res.status(204).end();
}));

// Centralized API error handling
router.use((err, req, res, next) => {
  if (res.headersSent) return next(err);

  if (err instanceof ApiError) {
    return res.status(err.status).json({
      message: err.message,
      data: null
    });
  }

  if (err.code === 11000) {
    return res.status(400).json({
      message: 'Email already in use',
      data: null
    });
  }

  if (
    err instanceof mongoose.Error.ValidationError ||
    err instanceof mongoose.Error.CastError ||
    (err instanceof SyntaxError && 'body' in err)
  ) {
    return res.status(400).json({
      message: 'Invalid request',
      data: null
    });
  }

  console.error('API error:', err);

  res.status(500).json({
    message: 'Internal server error',
    data: null
  });
});

module.exports = router;
