import { createContext, useContext } from "react";
import { resolveCreditTerms } from "./theme";

const CreditLabelContext = createContext(resolveCreditTerms());
const ShowScoreContext = createContext(true);

export function CreditLabelProvider({ appearance, children }) {
  return (
    <CreditLabelContext.Provider value={resolveCreditTerms(appearance)}>
      <ShowScoreContext.Provider value={appearance?.showScore !== false}>
        {children}
      </ShowScoreContext.Provider>
    </CreditLabelContext.Provider>
  );
}

export function useCreditTerms() {
  return useContext(CreditLabelContext);
}

export function useShowScore() {
  return useContext(ShowScoreContext);
}
