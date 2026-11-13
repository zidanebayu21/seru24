/**
 * @format
 */

// Polyfill harus dimuat paling awal: CSPRNG untuk @noble (crypto.getRandomValues), URL untuk supabase-js.
import 'react-native-get-random-values';
import 'react-native-url-polyfill/auto';
import './src/polyfills';

import { AppRegistry } from 'react-native';
import App from './src/App';
import { name as appName } from './app.json';

AppRegistry.registerComponent(appName, () => App);
