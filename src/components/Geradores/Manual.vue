<script setup>
import { ref } from 'vue';

const countryCode = ref('55');
const phoneNumber = ref('');
const variables = ref([]);
const tableData = ref([]);

let variablesCount = 0;

const addVariable = () => {
  variablesCount++;
  variables.value.push('');
};

const removeVariable = (index) => {
  variables.value.splice(index, 1);
  variablesCount--;
};

const updateVariable = (value, index) => {
  variables.value[index] = value;
};

const validatePhoneNumber = (phoneNumber) => {
  return /^\d{7,13}$/.test(phoneNumber.replace(/\s/g, ''));
};

const validateVariables = () => {
  return variables.value.every(variable => variable.trim() !== '');
};

const addData = () => {
  const variablesValid = validateVariables();
  const phoneNumberValid = validatePhoneNumber(phoneNumber.value);

  if (!phoneNumberValid) {
    alert("Número de telefone inválido!");
    return;
  }

  if (!variablesValid) {
    alert("Preencha todos os campos das variáveis!");
    return;
  }

  const formattedPhoneNumber = "+" + countryCode.value + phoneNumber.value;

  tableData.value.push({
    phoneNumber: formattedPhoneNumber,
    variables: [...variables.value]
  });

  phoneNumber.value = '';
};

const removeRow = (index) => {
  tableData.value.splice(index, 1);
};

const exportCSV = () => {
  let csvContent = "data:text/csv;charset=utf-8,phone";
  for (let i = 1; i <= variablesCount; i++) {
    csvContent += `,variable${i}`;
  }
  csvContent += "\n";

  tableData.value.forEach(row => {
    csvContent += `${row.phoneNumber},${row.variables.join(",")}\n`;
  });

  const fileName = prompt("Insira o nome do arquivo:");
  if (fileName) {
    const encodedUri = encodeURI(csvContent);
    const link = document.createElement("a");
    link.setAttribute("href", encodedUri);
    link.setAttribute("download", `${fileName}.csv`);
    document.body.appendChild(link);
    link.click();
  }
};
</script>

<template>
  <div class="bg-gray-100 mx-auto h-screen flex flex-col justify-center items-center p-10 sm:p-0">
    <div class="shadow-md bg-gray-50 rounded-lg p-6 w-full max-w-2xl">
      <h1 class="text-2xl font-semibold text-center mb-4 sm:mb-8"><i class="far fa-comments mr-2 text-4xl"></i>Gerador
        de Disparo</h1>

      <div class="flex">
        <div class="w-3/6">
          <label for="countryCode" class="font-semibold">DDD:</label>
          <select class="form-select block w-full border rounded-l-md px-3 py-1" v-model="countryCode">
            <option value="55">Brasil (+55)</option>
            <option value="351">Portugal (+351)</option>
            <option value="1">Estados Unidos (+1)</option>
            <option value="86">China (+86)</option>
            <option value="91">Índia (+91)</option>
            <option value="7">Rússia (+7)</option>
            <option value="81">Japão (+81)</option>
            <option value="44">Reino Unido (+44)</option>
            <option value="49">Alemanha (+49)</option>
            <option value="33">França (+33)</option>
          </select>
        </div>

        <div class=" w-full">
          <label for="phoneNumber" class="font-semibold">Número de Telefone:</label>
          <input type="text" class="form-input block w-full border rounded-r-md px-3 py-1" v-model="phoneNumber"
            placeholder="14998765432">
        </div>
      </div>

      <div id="variables" class="my-4">
        <div v-for="(variable, index) in variables" :key="index" class="flex items-center my-3">
          <label :for="`variable${index + 1}`"
            class="border px-3 py-1 hover:bg-gray-200 duration-200 rounded-l-md font-semibold">Variável {{ index + 1
            }}:</label>
          <input type="text" class="form-input flex-1 border rounded-0 px-3 py-1" :id="`variable${index + 1}`"
            :value="variable" @input="updateVariable($event.target.value, index)"
            :placeholder="`Digite o valor da Variável ${index + 1}`">
          <button class="border px-3 py-1 hover:bg-gray-200 duration-200 rounded-r-md text-red-500 hover:text-red-700"
            type="button" @click="removeVariable(index)">
            <i class="fa fa-trash"></i>
          </button>
        </div>
      </div>

      <div class="mt-3 flex justify-start">
        <button class="bg-blue-500 text-white py-2 px-4 rounded-md hover:bg-blue-600 duration-200" @click="addVariable">
          <i class="fa fa-plus"></i> Variável
        </button>
        <button class="bg-green-500 ml-2 text-white py-2 px-4 rounded-md hover:bg-green-600 duration-200"
          @click="addData">
          Salvar Cliente
        </button>
      </div>
    </div>

    <div class="w-full max-w-2xl mt-5">
      <div class="max-h-52 overflow-y-auto">
        <div class="bg-white shadow-md rounded-lg mb-2" v-for="(rowData, index) in tableData" :key="index">
          <div class="p-4 flex justify-between items-center">
            <div>
              <p class="font-semibold"><i class="fa fa-whatsapp me-2"></i>{{ rowData.phoneNumber }}</p>
              <p class="text-gray-600">Variáveis: {{ rowData.variables.join(", ") }}</p>
            </div>
            <div>
              <button class="text-red-500 hover:text-red-700 text-xl" @click="removeRow(index)">
                <i class="fa fa-trash"></i>
              </button>
            </div>
          </div>
        </div>
      </div>
      <button class="bg-green-500 text-white py-2 px-4 rounded-md hover:bg-green-600 duration-200 mt-3"
        @click="exportCSV">
        Exportar Arquivo
      </button>
    </div>
  </div>
</template>

<style scoped>
.max-h-52::-webkit-scrollbar {
  width: 12px;
}

.max-h-52::-webkit-scrollbar-thumb {
  background: #bdbdbd;
  border-radius: 8px;
}

.max-h-52::-webkit-scrollbar-thumb:hover {
  background: #afafaf;
}
</style>
