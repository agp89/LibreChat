import React, { useState, useEffect } from 'react';
import { Outlet } from 'react-router-dom';
import { useAtom } from 'jotai';
import { useMediaQuery } from '@librechat/client';
import { dataService } from 'librechat-data-provider';
import type { ContextType } from '~/common';
import {
  useSearchEnabled,
  useAssistantsMap,
  useAuthContext,
  useAgentsMap,
  useFileMap,
} from '~/hooks';
import {
  PromptGroupsProvider,
  AssistantsMapContext,
  AgentsMapContext,
  SetConvoProvider,
  FileMapContext,
} from '~/Providers';
import { EncryptionSetup, EncryptionUnlock } from '~/components/Auth';
import { useUserTermsQuery, useGetStartupConfig } from '~/data-provider';
import { Nav, MobileNav, NAV_WIDTH } from '~/components/Nav';
import { TermsAndConditionsModal } from '~/components/ui';
import { useHealthCheck } from '~/data-provider';
import { Banner } from '~/components/Banners';
import store from '~/store';

export default function Root() {
  const [showTerms, setShowTerms] = useState(false);
  const [bannerHeight, setBannerHeight] = useState(0);
  const [navVisible, setNavVisible] = useState(() => {
    const savedNavVisible = localStorage.getItem('navVisible');
    return savedNavVisible !== null ? JSON.parse(savedNavVisible) : true;
  });

  const { isAuthenticated, logout } = useAuthContext();
  const isSmallScreen = useMediaQuery('(max-width: 768px)');

  // Global health check - runs once per authenticated session
  useHealthCheck(isAuthenticated);

  const assistantsMap = useAssistantsMap({ isAuthenticated });
  const agentsMap = useAgentsMap({ isAuthenticated });
  const fileMap = useFileMap({ isAuthenticated });

  const { data: config } = useGetStartupConfig();
  const { data: termsData } = useUserTermsQuery({
    enabled: isAuthenticated && config?.interface?.termsOfService?.modalAcceptance === true,
  });

  useSearchEnabled(isAuthenticated);

  const [encryptionUnlocked, setEncryptionUnlocked] = useAtom(store.encryptionUnlocked);
  const [showEncryptionSetup, setShowEncryptionSetup] = useState(false);
  const [showEncryptionUnlock, setShowEncryptionUnlock] = useState(false);

  const encryptionEnabled = config?.encryptionEnabled === true;

  useEffect(() => {
    if (!isAuthenticated || !encryptionEnabled || encryptionUnlocked) {
      setShowEncryptionSetup(false);
      setShowEncryptionUnlock(false);
      return;
    }
    dataService
      .getEncryptionSalt()
      .then(() => {
        setShowEncryptionUnlock(true);
      })
      .catch((err: { response?: { status?: number } }) => {
        if (err?.response?.status === 404) {
          setShowEncryptionSetup(true);
        }
        // Other errors (network, 500, etc.) — skip encryption gate silently
      });
  }, [isAuthenticated, encryptionEnabled, encryptionUnlocked]);

  useEffect(() => {
    if (termsData) {
      setShowTerms(!termsData.termsAccepted);
    }
  }, [termsData]);

  const handleAcceptTerms = () => {
    setShowTerms(false);
  };

  const handleDeclineTerms = () => {
    setShowTerms(false);
    logout('/login?redirect=false');
  };

  if (!isAuthenticated) {
    return null;
  }

  return (
    <>
      {showEncryptionSetup && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50">
          <div className="w-full max-w-md rounded-xl bg-surface-primary shadow-2xl">
            <EncryptionSetup
              onSuccess={() => {
                setShowEncryptionSetup(false);
                setEncryptionUnlocked(true);
              }}
            />
          </div>
        </div>
      )}
      {showEncryptionUnlock && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50">
          <div className="w-full max-w-md rounded-xl bg-surface-primary shadow-2xl">
            <EncryptionUnlock
              onSuccess={() => {
                setShowEncryptionUnlock(false);
                setEncryptionUnlocked(true);
              }}
              onForgotPassphrase={() => {
                setShowEncryptionUnlock(false);
              }}
            />
          </div>
        </div>
      )}
      <SetConvoProvider>
        <FileMapContext.Provider value={fileMap}>
          <AssistantsMapContext.Provider value={assistantsMap}>
            <AgentsMapContext.Provider value={agentsMap}>
              <PromptGroupsProvider>
                <Banner onHeightChange={setBannerHeight} />
                <div className="flex" style={{ height: `calc(100dvh - ${bannerHeight}px)` }}>
                  <div className="relative z-0 flex h-full w-full overflow-hidden">
                    <Nav navVisible={navVisible} setNavVisible={setNavVisible} />
                    <div
                      className="relative flex h-full max-w-full flex-1 flex-col overflow-hidden"
                      style={
                        isSmallScreen
                          ? {
                              transform: navVisible
                                ? `translateX(${NAV_WIDTH.MOBILE}px)`
                                : 'translateX(0)',
                              transition: 'transform 0.2s ease-out',
                            }
                          : undefined
                      }
                      {...{ inert: navVisible && isSmallScreen ? '' : undefined }}
                    >
                      <MobileNav navVisible={navVisible} setNavVisible={setNavVisible} />
                      <Outlet context={{ navVisible, setNavVisible } satisfies ContextType} />
                    </div>
                  </div>
                </div>
              </PromptGroupsProvider>
            </AgentsMapContext.Provider>
            {config?.interface?.termsOfService?.modalAcceptance === true && (
              <TermsAndConditionsModal
                open={showTerms}
                onOpenChange={setShowTerms}
                onAccept={handleAcceptTerms}
                onDecline={handleDeclineTerms}
                title={config.interface.termsOfService.modalTitle}
                modalContent={config.interface.termsOfService.modalContent}
              />
            )}
          </AssistantsMapContext.Provider>
        </FileMapContext.Provider>
      </SetConvoProvider>
    </>
  );
}
