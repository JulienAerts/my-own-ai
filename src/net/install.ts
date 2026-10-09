// Imported first by the page and by each worker, before any library can keep a
// reference to the original fetch. Workers are named after what they do (the
// `name` option of new Worker), which becomes the source of their requests.
import { installNetLog } from './netlog';

installNetLog(typeof document === 'undefined' ? (self as { name?: string }).name || 'Background worker' : undefined);
