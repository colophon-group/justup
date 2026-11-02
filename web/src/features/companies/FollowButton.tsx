// Follow is separate from company navigation, with a stable native button.
import type { FollowControl } from './useFollows.ts';
import { useInterfaceLocale } from '../../i18n/LocaleProvider.tsx';
export function FollowButton({ companyId, name, follows }: { companyId: string; name: string; follows?: FollowControl | undefined }) {
  const { t } = useInterfaceLocale();
  if (!follows?.available) return null;
  const followed = follows.items.has(companyId);
  return <button type="button" className="follow-company button outline" disabled={follows.disabled}
    aria-label={t(followed ? 'Unfollow {company}' : 'Follow {company}', { company: name })}
    onClick={() => void follows.change(companyId, !followed)}>{t(followed ? 'Unfollow' : 'Follow')}</button>;
}
export function FollowNotice({ follows }: { follows?: FollowControl | undefined }) {
  const { t, notice } = useInterfaceLocale();
  return follows?.available && follows.error ? <p role="status" className="follow-notice">{notice(follows.error)}{' '}<button type="button" className="text-link" disabled={follows.busy} onClick={follows.retry}>{t('Reload follows')}</button></p> : null;
}
