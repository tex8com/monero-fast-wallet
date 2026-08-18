import { useEffect, useState } from 'react';
import {
  type CommunityV1Advertisement,
  MoneroEnthusiastV1Service,
} from '../backend/MoneroEnthusiastV1Service';

function isRenderableAdvertisement(value: CommunityV1Advertisement): boolean {
  return (
    typeof value.campaignId === 'string' &&
    value.campaignId.length > 0 &&
    typeof value.title === 'string' &&
    value.title.length > 0 &&
    typeof value.body === 'string' &&
    value.body.length > 0 &&
    typeof value.advertiserDisplayName === 'string' &&
    value.advertiserDisplayName.length > 0 &&
    typeof value.paidByDisplayName === 'string' &&
    value.paidByDisplayName.length > 0 &&
    value.destinationUrl.startsWith('https://') &&
    (value.sponsorshipLabel === 'advertisement' ||
      value.sponsorshipLabel === 'sponsored') &&
    (value.selectionReason === 'contextual_placement' ||
      value.selectionReason === 'local_interests')
  );
}

export function useLocalAdvertisement(enabled: boolean) {
  const [advertisement, setAdvertisement] =
    useState<CommunityV1Advertisement>();

  useEffect(() => {
    let active = true;
    if (!enabled) {
      setAdvertisement(undefined);
      return () => {
        active = false;
      };
    }

    MoneroEnthusiastV1Service.advertisements()
      .then(items => {
        if (active) {
          setAdvertisement(items.find(isRenderableAdvertisement));
        }
      })
      .catch(() => {
        if (active) setAdvertisement(undefined);
      });
    return () => {
      active = false;
    };
  }, [enabled]);

  return advertisement;
}
