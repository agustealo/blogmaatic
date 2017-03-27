from django import forms
from .models import Book

class BookForm(forms.ModelForm):

    class Meta:
        model = Book
        fields = ('book_name', 'introduction',)
        
# imageupload

class ImageUpload(forms.Form):
    image = forms.FileField(widget=forms.ClearableFileInput(attrs={'multiple': True}))
    
class Admin(forms.Form):
    user_name = forms.CharField(max_length = 100)
    first_name = forms.CharField(max_length = 100)
    last_name = forms.CharField(max_length = 100)
    picture = forms.ImageField()