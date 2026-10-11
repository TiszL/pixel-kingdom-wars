import { useCallback, useLayoutEffect, useRef } from 'react';
import { requestUserCommand, type UserCommandHandle } from '../../state/store';

/** Original UI producer lifetime and live admission, without retaining a DOM
 * event. Returning the cancellation also lets effects retire superseded work. */
export function useUserCommand(admitted: () => boolean = () => true):
  (command: () => unknown, canRun?: () => boolean) => UserCommandHandle {
  const alive = useRef(false);
  const admission = useRef(admitted);
  admission.current = admitted;
  const pending = useRef(new Set<UserCommandHandle>());
  useLayoutEffect(() => { alive.current = true; return () => { alive.current = false; for (const handle of pending.current) handle(); pending.current.clear(); }; }, []);
  return useCallback((command: () => unknown, canRun: () => boolean = () => true) => {
    const handle = requestUserCommand(command, () => alive.current && admission.current() && canRun());
    pending.current.add(handle); handle.onSettled(() => { pending.current.delete(handle); });
    return handle;
  }, []);
}
