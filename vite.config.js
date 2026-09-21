import {defineConfig} from 'vite';
export default defineConfig({server:{port:5173,proxy:{'/insider-api':{target:'http://127.0.0.1:8011',rewrite:p=>p.replace('/insider-api','')},'/aster-api':{target:'http://127.0.0.1:8010',rewrite:p=>p.replace('/aster-api','')}}}});
