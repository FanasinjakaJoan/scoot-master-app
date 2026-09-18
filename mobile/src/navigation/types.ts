import type { BottomTabScreenProps } from '@react-navigation/bottom-tabs';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';

/** Paramètres de navigation (liste plate : onglets + écrans de détail empilés). */
export type RootStackParamList = {
  Tabs: undefined;
  Dashboard: undefined;
  Catalog: undefined;
  Sales: undefined;
  Customers: undefined;
  Sync: undefined;
  UserManagement: undefined;
  BikeDetail: { id: string };
  BikeForm: { id?: string };
  CustomerDetail: { id: string };
  CustomerForm: { id?: string };
  SaleDetail: { id: string };
  SaleForm: { id?: string };
};

/**
 * Props structurelles minimales, satisfaites à la fois par la pile native
 * (écrans de détail) et les onglets (navigation composite vers la pile parente).
 */
export type NavigatorProp<T extends keyof RootStackParamList> = {
  navigation: {
    navigate: (name: keyof RootStackParamList, params?: RootStackParamList[keyof RootStackParamList]) => void;
    goBack: () => void;
    canGoBack: () => boolean;
  };
  route: {
    params: RootStackParamList[T];
  };
};

// Types complets conservés pour référence / éventuel renforcement.
export type FullTabProp<T extends keyof RootStackParamList> = BottomTabScreenProps<RootStackParamList, T>;
export type FullStackProp<T extends keyof RootStackParamList> = NativeStackScreenProps<RootStackParamList, T>;
