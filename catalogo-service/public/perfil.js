// Mostrar/Esconder menu ao clicar na foto
function toggleProfileMenu() {
    const dropdown = document.getElementById('profile-dropdown');
    dropdown.style.display = dropdown.style.display === 'flex' ? 'none' : 'flex';
}

function openProfileModal() {
    document.getElementById('profile-dropdown').style.display = 'none';
    document.getElementById('profile-modal').style.display = 'block';
    carregarDadosDoPerfil(); // Busca nome, bio e foto no backend
}

function closeProfileModal() {
    document.getElementById('profile-modal').style.display = 'none';
}

// Carregar dados no carregamento e ao abrir modal
async function carregarDadosDoPerfil() {
    const token = localStorage.getItem('token');
    if(!token) return;

    const response = await fetch('/api/auth/profile', {
        headers: { 'Authorization': `Bearer ${token}` }
    });
    
    if (response.ok) {
        const user = await response.json();
        if(user.profile_picture) {
            document.getElementById('avatar-img').src = user.profile_picture;
        }
        document.getElementById('bio-input').value = user.bio || '';
        // Lógica para preencher document.getElementById('favorites-list') baseada na sua Atividade 2...
    }
}
// Chame carregarDadosDoPerfil() no window.onload para a foto aparecer assim que logar.

// Fazer o Upload com FormData (Suporta Arquivos Binários)
document.getElementById('profile-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const token = localStorage.getItem('token');
    
    // FormData empacota o texto (bio) + arquivo binário (imagem) da mesma requisição
    const formData = new FormData();
    formData.append('bio', document.getElementById('bio-input').value);
    
    const fileInput = document.getElementById('file-input');
    if (fileInput.files.length > 0) {
        formData.append('profile_picture', fileInput.files[0]);
    }

    const response = await fetch('/api/auth/profile', {
        method: 'PUT',
        headers: { 'Authorization': `Bearer ${token}` }, // Sem Content-Type, o browser configura sozinho pro FormData
        body: formData
    });

    if (response.ok) {
        alert('Perfil atualizado com sucesso!');
        carregarDadosDoPerfil(); // Recarrega a foto na bolinha
        closeProfileModal();
    } else {
        const err = await response.json();
        alert('Erro: ' + err.error);
    }
});