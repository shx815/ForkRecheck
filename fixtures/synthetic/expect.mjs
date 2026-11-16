import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';

const {score} = await import(pathToFileURL(resolve('score.js')));
if (process.argv[2] === 'regression') {
  if (score([2, 3], [1, 3])) {
    console.log('FORK_RECHECK:first-value-ignored');
    process.exitCode = 42;
  } else {
    console.log('FORK_RECHECK:regression-pass');
  }
} else {
  if (!score([1, 3], [1, 3]) || score([1, 4], [1, 3])) throw new Error('AssertionError: control case');
  console.log('FORK_RECHECK:related-pass');
}
