import { useState, useEffect } from 'react';
import { authApi } from '../api/auth';

/**
 * Whether this instance accepts new accounts.
 *
 * `null` means "not known yet" — callers that render a signup affordance
 * should treat it as closed and show nothing, so a link never flashes in and
 * back out on the (now default) closed instance.
 *
 * A failed request resolves to `true`: the server is the authority and
 * rejects a closed registration anyway, so a transient network error should
 * not lock a legitimate user out of the signup page.
 */
export function useRegistrationOpen(): boolean | null {
    const [isOpen, setIsOpen] = useState<boolean | null>(null);

    useEffect(() => {
        let cancelled = false;
        authApi.registrationStatus()
            .then((res) => { if (!cancelled) setIsOpen(res.data.allowPublicRegistration); })
            .catch(() => { if (!cancelled) setIsOpen(true); });
        return () => { cancelled = true; };
    }, []);

    return isOpen;
}
